/* ============================================================
 *  EverFlo remote control – XIAO ESP32-S3 Sense
 *  ------------------------------------------------------------
 *  Features:
 *   - Captive portal for wifi setup (WiFiManager)
 *   - MJPEG camera stream (port 81) of the flow meter ball
 *   - Swedish web page (port 80) with large +/− buttons
 *   - Motor control: NEMA17+TMC2209 (STEP/DIR/EN)
 *   - Freewheel between adjustments (EN pin)
 *   - Position counter kept in flash (informational only – the
 *     camera is the truth; the knob can be turned by hand or slip)
 *   - Camera sensor PID written to the serial log at boot
 *
 *  Code and comments are English; all user-facing text stays
 *  Swedish (the patient reads it). Wire formats – URLs, JSON
 *  field names, NVS keys – keep their original names on purpose:
 *  renaming them would break the control panel or lose the
 *  stored position.
 *
 *  Arduino IDE settings:
 *   Board: "XIAO_ESP32S3"  (esp32 by Espressif, v3.x)
 *   PSRAM: "OPI PSRAM"  (required by the camera!)
 *   Libraries: "WiFiManager" (tzapu) via Library Manager
 *              "TMCStepper" only when USE_TMC_UART is 1
 *
 *  Calibration: see README_koppling.md
 * ============================================================ */

#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WiFiManager.h>          // tzapu – captive portal
#include <ESPmDNS.h>
#include <Preferences.h>
#include "esp_http_server.h"
#include "esp_log.h"

/* Local, gitignored. See secrets.h.example. Everything it configures is
   optional: without the file the sketch still builds, with the feature off. */
#if __has_include("secrets.h")
  #include "secrets.h"
#endif
#ifndef HEALTHCHECK_URL
  #define HEALTHCHECK_URL ""      // empty = health ping disabled
#endif
#ifndef INGEST_URL
  #define INGEST_URL ""           // empty = cloud upload disabled
#endif
#ifndef INGEST_TOKEN
  #define INGEST_TOKEN ""
#endif

#define FW_VERSION "1.7.1"

/* ---------------- MOTOR ---------------- */
#define USE_TMC_UART 0            // 1 = current control + true freewheel over UART
                                  //     (needs TMCStepper library + 1k resistor, see README)

/* ---------------- MOVEMENT ---------------- */
#define DEG_PER_PRESS   15        // motor shaft degrees per button press.
                                  // Lego measurement: ~15° ≈ 0.1 L with a coaxial 1:1 coupling.
                                  // ADJUST after calibrating against the ball!
#define DIRECTION       -1        // 1 or -1 when + turns the wrong way
                                  // (-1 since v1.6.2: verified on site)
#define STEP_DEG_MIN    4         // clamp range for /api/steg: about 25–300 %
#define STEP_DEG_MAX    45        // of DEG_PER_PRESS (15). RAM only, see stepDegrees.
#define MICROSTEPS      8         // TMC2209 standalone: MS1=MS2=GND => 1/8
#define STEP_PAUSE_US   2500      // µs between microsteps (lower = faster)

/* ---------------- SECURITY ---------------- */
#define WEB_PIN ""                // e.g. "4711" => requires ?pin=4711 on API calls.
                                  // Empty = off (simplest for the patient; anyone on
                                  // the home network can control the motor)

/* ---------------- CAMERA ---------------- */
#define CAMERA_VFLIP    0         // 1 when the image is upside down
#define CAMERA_HMIRROR  0         // 1 when mirrored

/* ---------------- PINS ---------------- */
#define PIN_STEP D0
#define PIN_DIR  D1
#define PIN_EN   D2               // active LOW. HIGH = driver off = freewheel
#define PIN_TMC_RX D7             // UART mode only
#define PIN_TMC_TX D6

#if USE_TMC_UART
  #include <TMCStepper.h>
  #define R_SENSE 0.11f
  TMC2209Stepper tmc(&Serial1, R_SENSE, 0b00);
#endif

/* ---------------- CAMERA PINS (XIAO ESP32-S3 Sense) --------- */
#define CAM_PWDN  -1
#define CAM_RESET -1
#define CAM_XCLK  10
#define CAM_SIOD  40
#define CAM_SIOC  39
#define CAM_Y9    48
#define CAM_Y8    11
#define CAM_Y7    12
#define CAM_Y6    14
#define CAM_Y5    16
#define CAM_Y4    18
#define CAM_Y3    17
#define CAM_Y2    15
#define CAM_VSYNC 38
#define CAM_HREF  47
#define CAM_PCLK  13

/* ---------------- GLOBALS ---------------- */
Preferences prefs;
volatile int position = 0;        // current position in number of presses
volatile bool busy = false;       // motor is moving
volatile int stepDegrees = DEG_PER_PRESS;  // degrees/press, adjustable via /api/steg
                                           // (RAM only – reboot restores the default)
bool cameraOK = false;
httpd_handle_t ctrl_httpd = NULL;
httpd_handle_t stream_httpd = NULL;
volatile uint32_t stream_gen = 0;   // a new viewer kicks out the old one
#define HEARTBEAT_PIN 21            // XIAO user LED (active low): blink = alive

/* Log ring – latest lines reachable via http://<ip>/log */
String logBuf[40]; int logIdx = 0;
void logLine(const String &s) {
  Serial.println(s);
  logBuf[logIdx % 40] = s;
  logIdx++;
}

/* ============================================================
 *  MOTOR
 * ============================================================ */
int stepsPerPress() {             // microsteps per press
  return (int)(stepDegrees / (1.8f / MICROSTEPS) + 0.5f);
}
void motorInit() {
  pinMode(PIN_STEP, OUTPUT);
  pinMode(PIN_DIR,  OUTPUT);
  pinMode(PIN_EN,   OUTPUT);
  digitalWrite(PIN_EN, HIGH);     // start in freewheel
#if USE_TMC_UART
  Serial1.begin(115200, SERIAL_8N1, PIN_TMC_RX, PIN_TMC_TX);
  tmc.begin();
  tmc.rms_current(600);           // mA – plenty for the knob, runs cool
  tmc.microsteps(MICROSTEPS);
  tmc.ihold(0);                   // no holding current
  tmc.freewheel(1);               // true freewheel at standstill
#endif
}
void motorEngage()  { digitalWrite(PIN_EN, LOW);  delay(30); }
void motorRelease() { digitalWrite(PIN_EN, HIGH); }         // freewheel
void motorStep(int direction) {
  digitalWrite(PIN_DIR, (direction * DIRECTION) > 0 ? HIGH : LOW);
  int n = stepsPerPress();
  for (int i = 0; i < n; i++) {
    digitalWrite(PIN_STEP, HIGH); delayMicroseconds(4);
    digitalWrite(PIN_STEP, LOW);  delayMicroseconds(STEP_PAUSE_US);
  }
}

/* Set by move(), read by loop(): upload one frame once a press series has
   gone quiet. What we wait for is the end of the series, not the ball —
   it settles in well under a second. */
volatile unsigned long lastPressAt = 0;
volatile bool uploadAfterPress = false;

/* Move + store position (the counter is information, not a limit) */
bool move(int direction) {
  if (busy) return false;
  int next = position + direction;
  busy = true;
  motorEngage();
  motorStep(direction);
  motorRelease();
  position = next;
  prefs.putInt("lage", position);           // NVS key kept: renaming loses the stored position
  logLine(String("Position: ") + position);
  lastPressAt = millis();
  uploadAfterPress = true;
  busy = false;
  return true;
}

/* ============================================================
 *  CAMERA
 * ============================================================ */
bool cameraInit() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0=CAM_Y2; c.pin_d1=CAM_Y3; c.pin_d2=CAM_Y4; c.pin_d3=CAM_Y5;
  c.pin_d4=CAM_Y6; c.pin_d5=CAM_Y7; c.pin_d6=CAM_Y8; c.pin_d7=CAM_Y9;
  c.pin_xclk=CAM_XCLK; c.pin_pclk=CAM_PCLK;
  c.pin_vsync=CAM_VSYNC; c.pin_href=CAM_HREF;
  c.pin_sccb_sda=CAM_SIOD; c.pin_sccb_scl=CAM_SIOC;
  c.pin_pwdn=CAM_PWDN; c.pin_reset=CAM_RESET;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size   = FRAMESIZE_VGA;   // 640x480 – right size for the ball
  c.jpeg_quality = 12;
  c.fb_count     = 2;
  c.fb_location  = CAMERA_FB_IN_PSRAM;
  c.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;  // idle when nobody watches => no FB-OVF

  if (esp_camera_init(&c) != ESP_OK) return false;

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    const char *name = "unknown";
    if      (s->id.PID == 0x3660) name = "OV3660 (new camera)";
    else if (s->id.PID == 0x26)   name = "OV2640 (older camera)";
    else if (s->id.PID == 0x5640) name = "OV5640";
    Serial.printf("Camera sensor PID=0x%04x -> %s\n", s->id.PID, name);
    s->set_vflip(s, CAMERA_VFLIP);
    s->set_hmirror(s, CAMERA_HMIRROR);
  }
  return true;
}

/* ============================================================
 *  WEB
 *  The page text is Swedish on purpose – the patient reads it.
 * ============================================================ */
static const char PAGE[] = R"HTML(
<!DOCTYPE html><html lang="sv"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Syrgas – fjärrkontroll</title>
<style>
 body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0;background:#f4f4f2;
      display:flex;flex-direction:column;align-items:center;gap:14px;padding:12px}
 h1{font-size:1.3rem;margin:6px 0 0;color:#333}
 #camwrap{width:100%;max-width:480px;aspect-ratio:3/4;overflow:hidden;border-radius:12px;
          background:#000;display:flex;align-items:center;justify-content:center;position:relative}
 #camwrap img{width:133.4%;transform:rotate(90deg) scaleX(-1)}
 #camwrap.stale img{opacity:.3}
 #stale{display:none;position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);
        background:#a33;color:#fff;text-align:center;padding:16px 10px;
        font-size:1.2rem;font-weight:700;line-height:1.35}
 #stale small{display:block;font-size:.9rem;font-weight:400;margin-top:4px}
 #camwrap.stale #stale{display:block}
 .position{font-size:1.6rem;color:#333}
 .position b{font-size:2.2rem}
 button{width:100%;max-width:480px;font-size:2.4rem;padding:26px 0;border:none;
        border-radius:16px;color:#fff;font-weight:700;cursor:pointer}
 #plus{background:#1c8a4c}
 #minus{background:#4a6fa5}
 button:disabled{opacity:.45}
 #msg{min-height:1.4em;font-size:1.1rem;color:#a33}
 .small{font-size:.85rem;color:#888;margin-top:18px}
</style></head><body>
<h1>Syrgas – fjärrkontroll</h1>
<div id="camwrap"><img id="cam" alt="Kamerabild laddas...">
<div id="stale">Bilden uppdateras inte<small id="staleAge"></small></div></div>
<div class="position">Läge: <b id="position">–</b></div>
<button id="plus" onclick="press('plus')">+ MER</button>
<button id="minus" onclick="press('minus')">&minus; MINDRE</button>
<div id="msg"></div>
<div class="small"><a href="#" onclick="resetCounter();return false">Nollställ räknare (tekniker)</a> · <a href="#" onclick="restart();return false">Starta om enheten</a> · v%VER%</div>
<script>
const PIN='%PIN%'; const q = PIN ? ('?pin='+PIN) : '';
const cam=document.getElementById('cam');
let lastFrameAt=Date.now();
function nextFrame(){ cam.src='/bild?t='+Date.now(); }
cam.onload  = ()=>{ lastFrameAt=Date.now(); setTimeout(nextFrame, 250); };  // ~4 frames/s
cam.onerror = ()=>setTimeout(nextFrame, 1000);  // slow retry on error, self-healing
// A frame that stopped updating looks exactly like a live one. Without this
// warning the operator can believe they see the present and press blind.
setInterval(()=>{
  const age=Math.round((Date.now()-lastFrameAt)/1000);
  document.getElementById('camwrap').classList.toggle('stale', age>=5);
  if(age>=5) document.getElementById('staleAge').textContent=
    'Senaste bild för '+age+' sekunder sedan. Tryck inte förrän bilden är tillbaka.';
}, 1000);
nextFrame();
async function status(){
  try{ const j = await (await fetch('/api/status'+q)).json();
       document.getElementById('position').textContent = j.lage; }catch(e){}
}
async function press(op){
  const b1=document.getElementById('plus'), b2=document.getElementById('minus');
  b1.disabled=b2.disabled=true;
  document.getElementById('msg').textContent='';
  try{
    const j = await (await fetch('/api/'+op+q)).json();
    document.getElementById('position').textContent = j.lage;
    if(!j.ok) document.getElementById('msg').textContent='Motorn är upptagen – vänta';
  }catch(e){ document.getElementById('msg').textContent='Ingen kontakt'; }
  b1.disabled=b2.disabled=false;
}
async function resetCounter(){
  if(!confirm('Nollställa räknaren? (endast vid ominstallation)'))return;
  const j = await (await fetch('/api/nollstall'+q)).json();
  document.getElementById('position').textContent=j.lage;
}
async function restart(){
  if(!confirm('Starta om enheten? Bilden återkommer inom en minut.'))return;
  try{ await fetch('/api/omstart'+q); }catch(e){}
  document.getElementById('msg').textContent='Startar om...';
}
status(); setInterval(status,10000);
</script></body></html>
)HTML";

bool pinOK(httpd_req_t *req) {
  if (strlen(WEB_PIN) == 0) return true;
  char buf[64]; char val[16] = "";
  if (httpd_req_get_url_query_str(req, buf, sizeof(buf)) == ESP_OK)
    httpd_query_key_value(buf, "pin", val, sizeof(val));
  return strcmp(val, WEB_PIN) == 0;
}

esp_err_t sendJson(httpd_req_t *req, bool ok) {
  char b[64];
  snprintf(b, sizeof(b), "{\"ok\":%s,\"lage\":%d}",   // JSON field kept: the page reads it
           ok ? "true" : "false", position);
  httpd_resp_set_type(req, "application/json");
  // CORS on every JSON API, not just /api/steg. The control panel runs from
  // a different origin and today fires the motor calls no-cors, which makes
  // a 403 or a wrong host indistinguishable from success. With this header
  // it can read the reply and tell whether the press actually landed — and
  // that page can be changed from anywhere, while this firmware cannot.
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, b, HTTPD_RESP_USE_STRLEN);
}

esp_err_t h_index(httpd_req_t *req) {
  String s(PAGE);
  s.replace("%PIN%", WEB_PIN);
  s.replace("%VER%", FW_VERSION);
  httpd_resp_set_type(req, "text/html; charset=utf-8");
  return httpd_resp_send(req, s.c_str(), s.length());
}
esp_err_t h_plus(httpd_req_t *req)  { if(!pinOK(req)) return httpd_resp_send_err(req,HTTPD_403_FORBIDDEN,"pin"); return sendJson(req, move(+1)); }
esp_err_t h_minus(httpd_req_t *req) { if(!pinOK(req)) return httpd_resp_send_err(req,HTTPD_403_FORBIDDEN,"pin"); return sendJson(req, move(-1)); }
esp_err_t h_reset(httpd_req_t *req) { if(!pinOK(req)) return httpd_resp_send_err(req,HTTPD_403_FORBIDDEN,"pin"); position=0; prefs.putInt("lage",0); return sendJson(req,true); }
esp_err_t h_status(httpd_req_t *req){ return sendJson(req, true); }
esp_err_t h_restart(httpd_req_t *req){
  if(!pinOK(req)) return httpd_resp_send_err(req,HTTPD_403_FORBIDDEN,"pin");
  sendJson(req, true);
  logLine("Restart via web link");
  delay(300);
  ESP.restart();
  return ESP_OK;
}
/* Step size (degrees/press), RAM only. Same CORS as /bild. */
esp_err_t sendStepJson(httpd_req_t *req) {
  char b[96];
  snprintf(b, sizeof(b), "{\"steg\":%d,\"min\":%d,\"max\":%d,\"standard\":%d}",
           stepDegrees, STEP_DEG_MIN, STEP_DEG_MAX, DEG_PER_PRESS);
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, b, HTTPD_RESP_USE_STRLEN);
}
esp_err_t h_step(httpd_req_t *req) {
  if(!pinOK(req)) return httpd_resp_send_err(req,HTTPD_403_FORBIDDEN,"pin");
  char buf[64]; char val[16] = "";
  if (httpd_req_get_url_query_str(req, buf, sizeof(buf)) == ESP_OK &&
      httpd_query_key_value(buf, "v", val, sizeof(val)) == ESP_OK) {
    char *end = NULL;
    long v = strtol(val, &end, 10);
    if (end != val && *end == '\0' && v >= 0) {   // invalid/negative/empty = ignore
      if (v < STEP_DEG_MIN) v = STEP_DEG_MIN;
      if (v > STEP_DEG_MAX) v = STEP_DEG_MAX;
      stepDegrees = (int)v;
      logLine(String("Step size: ") + stepDegrees + " degrees/press");
    }
  }
  return sendStepJson(req);
}
esp_err_t h_log(httpd_req_t *req) {
  String s;
  for (int i = 0; i < 40; i++) {
    int k = (logIdx + i) % 40;
    if (logBuf[k].length()) { s += logBuf[k]; s += "\n"; }
  }
  httpd_resp_set_type(req, "text/plain; charset=utf-8");
  return httpd_resp_send(req, s.c_str(), s.length());
}
esp_err_t h_snapshot(httpd_req_t *req) {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) return httpd_resp_send_500(req);
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  esp_err_t r = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return r;
}

/* MJPEG stream */
esp_err_t h_stream(httpd_req_t *req) {
  char part[96];
  uint32_t min_gen = ++stream_gen;   // this connection is now the only valid viewer
  httpd_resp_set_type(req, "multipart/x-mixed-replace;boundary=fr");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  while (stream_gen == min_gen) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) { httpd_resp_send_500(req); return ESP_FAIL; }
    size_t hl = snprintf(part, sizeof(part),
      "--fr\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", fb->len);
    if (httpd_resp_send_chunk(req, part, hl) != ESP_OK ||
        httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len) != ESP_OK ||
        httpd_resp_send_chunk(req, "\r\n", 2) != ESP_OK) {
      esp_camera_fb_return(fb);
      break;                       // the client closed
    }
    esp_camera_fb_return(fb);
  }
  return ESP_OK;
}

void startWebServer() {
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port = 80;
  cfg.max_uri_handlers = 10;
  if (httpd_start(&ctrl_httpd, &cfg) == ESP_OK) {
    httpd_uri_t u;   // URL paths keep their Swedish names – the control panel depends on them
    u = {.uri="/",              .method=HTTP_GET, .handler=h_index,   .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/api/plus",      .method=HTTP_GET, .handler=h_plus,    .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/api/minus",     .method=HTTP_GET, .handler=h_minus,   .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/api/nollstall", .method=HTTP_GET, .handler=h_reset,   .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/api/omstart",   .method=HTTP_GET, .handler=h_restart, .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/api/status",    .method=HTTP_GET, .handler=h_status,  .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/api/steg",      .method=HTTP_GET, .handler=h_step,    .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/log",           .method=HTTP_GET, .handler=h_log,     .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/bild",          .method=HTTP_GET, .handler=h_snapshot,.user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
  }
  if (cameraOK) {
    httpd_config_t cfg2 = HTTPD_DEFAULT_CONFIG();
    cfg2.server_port = 81;
    cfg2.ctrl_port   = 32769;      // own control port, otherwise it clashes with the port 80 server
    cfg2.lru_purge_enable = true;  // drop the oldest connection when short
    cfg2.send_wait_timeout = 5;    // release dead clients within 5 s
    cfg2.recv_wait_timeout = 5;
    if (httpd_start(&stream_httpd, &cfg2) == ESP_OK) {
      httpd_uri_t u = {.uri="/stream", .method=HTTP_GET, .handler=h_stream, .user_ctx=NULL};
      httpd_register_uri_handler(stream_httpd, &u);
      logLine("Stream server: port 81 OK");
    } else {
      logLine("STREAM SERVER FAILED (port 81)");
    }
  } else {
    logLine("Stream server skipped (no camera)");
  }
}

/* ============================================================
 *  HEALTH PING (dead man's switch)
 *  A ping every 5 minutes to healthchecks.io. Sending nothing IS the
 *  alarm, so a dead camera simply skips the ping and lets the grace
 *  period expire — no need for an explicit failure signal.
 *  Gate on a real frame: without it we would only be reporting "the
 *  ESP32 has power", and a wedged camera is exactly the fault that
 *  otherwise never surfaces.
 * ============================================================ */
#define PING_INTERVAL_MS 300000UL   // 5 min. Pair with grace 15 min at the
                                    // other end: alerts 20 min after silence.
unsigned long lastPing = 0;

bool cameraDelivers() {
  if (!cameraOK) return false;
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) return false;
  bool ok = fb->len > 1000;         // a plausible JPEG, not a truncated frame
  esp_camera_fb_return(fb);
  return ok;
}

/* Blocks for the TLS handshake (1-3 s). That is fine here: the web server
   runs in its own task, so only the heartbeat LED pauses. */
bool pingHealth() {
  if (strlen(HEALTHCHECK_URL) == 0) return false;
  WiFiClientSecure client;
  client.setInsecure();             // no cert pinning. The ping carries no
                                    // secret, and a man in the middle can only
                                    // suppress it — which shows up as a missed
                                    // check, i.e. the alarm we already want.
  HTTPClient http;
  if (!http.begin(client, HEALTHCHECK_URL)) {
    logLine("Ping: begin failed");
    return false;
  }
  // Timeouts set on HTTPClient only: Client::setTimeout has meant seconds in
  // some core versions and milliseconds in others, and getting it wrong the
  // slow way would block loop() for a very long time.
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  int code = http.GET();
  http.end();
  // Only failures are logged, and at most one per hour. Successes would
  // flush the 40-line ring within hours, and so would a sustained outage —
  // which is exactly when the wifi lines above it are worth keeping.
  static unsigned long lastFailLog = 0;
  if (code != 200 && (lastFailLog == 0 || millis() - lastFailLog > 3600000UL)) {
    lastFailLog = millis();
    logLine(String("Ping: HTTP ") + code + ", heap " + ESP.getFreeHeap());
  }
  return code == 200;
}

/* ============================================================
 *  CLOUD UPLOAD
 *  One frame to the ingest Worker, which stores the image in R2 and a row
 *  in D1. Fire and forget: a failed upload is not retried and not
 *  buffered. A gap in the log IS the record that the device or the network
 *  was down, and buffering would only make a stale image look current.
 *  The reading itself is not computed here — the camera image is the
 *  record until an analysis path is validated against the labelled set.
 * ============================================================ */
#define UPLOAD_INTERVAL_MS 900000UL   // 15 min
#define PRESS_SETTLE_MS      5000UL   // quiet time that ends a press series
unsigned long lastUpload = 0;

/* Blocks for a few seconds. Same reasoning as pingHealth(): the web server
   has its own task, so only the heartbeat pauses. */
bool uploadFrame(const char *reason) {
  if (strlen(INGEST_URL) == 0) return false;
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) return false;

  String url = String(INGEST_URL) + "?reason=" + reason +
               "&position=" + position +
               "&steg=" + stepDegrees +
               "&uptime=" + (millis() / 1000) +
               "&rssi=" + WiFi.RSSI() +
               "&fw=" FW_VERSION;

  WiFiClientSecure client;
  client.setInsecure();               // see pingHealth() for why
  HTTPClient http;
  bool ok = false;
  if (http.begin(client, url)) {
    http.setConnectTimeout(5000);
    http.setTimeout(15000);           // 30 kB over TLS on a weak link
    http.addHeader("authorization", "Bearer " INGEST_TOKEN);
    http.addHeader("content-type", "image/jpeg");
    int code = http.POST(fb->buf, fb->len);
    ok = (code == 204);
    // Rate-limited for the same reason as the ping: a sustained outage
    // would otherwise flush the 40-line ring and take the wifi lines that
    // explain the outage with it.
    static unsigned long lastFailLog = 0;
    if (!ok && (lastFailLog == 0 || millis() - lastFailLog > 3600000UL)) {
      lastFailLog = millis();
      logLine(String("Upload ") + reason + ": HTTP " + code +
              ", heap " + ESP.getFreeHeap());
    }
    http.end();
  }
  esp_camera_fb_return(fb);
  return ok;
}

/* ============================================================
 *  SELF-HEALING WIFI (runtime)
 *  The boot path is healed by WiFiManager; this covers a network
 *  lost AFTER a successful start: 3 reconnect attempts 15 s apart,
 *  then a restart (WiFiManager takes over with the portal if needed).
 * ============================================================ */
unsigned long wifiLastTry = 0;
int wifiAttempts = 0;
void wifiWatchdog() {
  if (WiFi.status() == WL_CONNECTED) {
    // Back after a drop: ping straight away so the outage reads as a short
    // gap rather than a long one, and a brief blip never reaches the alarm.
    if (wifiAttempts > 0) lastPing = millis() - PING_INTERVAL_MS;
    wifiAttempts = 0;
    return;
  }
  unsigned long now = millis();
  if (now - wifiLastTry < 15000) return;
  wifiLastTry = now;
  wifiAttempts++;
  if (wifiAttempts <= 3) {
    logLine(String("Wifi lost - retry ") + wifiAttempts + "/3");
    WiFi.reconnect();
  } else {
    logLine("Wifi could not be restored - restarting");
    delay(200);
    ESP.restart();
  }
}

/* ============================================================
 *  SETUP / LOOP
 * ============================================================ */
void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(HEARTBEAT_PIN, OUTPUT);
  digitalWrite(HEARTBEAT_PIN, HIGH);   // off (active low)
  esp_log_level_set("cam_hal", ESP_LOG_ERROR);  // silence harmless FB-OVF warnings
  logLine("=== EverFlo remote control v" FW_VERSION " starting ===");

  prefs.begin("everflo", false);
  position = prefs.getInt("lage", 0);
  Serial.printf("Stored position: %d\n", position);

  motorInit();
  Serial.printf("Motor: NEMA17+TMC2209, %d degrees/press\n", DEG_PER_PRESS);

  esp_log_level_set("cam_hal", ESP_LOG_NONE);  // silence harmless FB-OVF lines
  cameraOK = cameraInit();
  logLine(cameraOK ? "Camera OK" : "CAMERA FAILED (check the PSRAM setting!)");

  // Captive portal: the first time (or when no saved wifi exists) the XIAO
  // starts its own hotspot "Syrgas-setup". Connect with the phone, pick the
  // home wifi and enter the password. After that it connects on its own.
  WiFiManager wm;
  wm.setHostname("syrgas");
  wm.setConnectTimeout(15);        // per attempt
  wm.setConnectRetries(3);         // three attempts before the portal
  wm.setConfigPortalTimeout(120);  // portal max 2 min, then restart + new attempt
  if (!wm.autoConnect("Syrgas-setup")) {
    logLine("Wifi failed - restarting and trying again");
    delay(500);
    ESP.restart();
  }
  logLine(String("Connected! IP: ") + WiFi.localIP().toString());

  if (MDNS.begin("syrgas")) Serial.println("Address: http://syrgas.local");

  startWebServer();
  Serial.println("Web page: port 80, stream: port 81");
  logLine(strlen(HEALTHCHECK_URL) ? "Health ping: on, every 5 min"
                                  : "Health ping: off (not configured)");
  logLine(strlen(INGEST_URL) ? "Cloud upload: on, every 15 min and after presses"
                             : "Cloud upload: off (not configured)");
  logLine("=== Ready ===");

  lastPing = millis();
  lastUpload = millis();
  // The result of the first attempt is logged even on success. Everything
  // after this only logs failures, but on a first boot at the installation
  // site /log is the only way to see that the cloud path actually works —
  // absence of errors is not the same as proof it went through.
  if (cameraDelivers()) {
    bool ping = pingHealth();           // boot ping shortens the outage gap
    bool up = uploadFrame("boot");      // and one frame of "this is how it looked"
    if (strlen(HEALTHCHECK_URL)) logLine(ping ? "Boot ping: OK" : "Boot ping: FAILED");
    if (strlen(INGEST_URL))      logLine(up   ? "Boot upload: OK" : "Boot upload: FAILED");
  } else {
    logLine("Boot: camera gave no frame, skipped ping and upload");
  }
}

void loop() {
  wifiWatchdog();

  bool online = !busy && WiFi.status() == WL_CONNECTED;

  if (online && millis() - lastPing > PING_INTERVAL_MS) {
    lastPing = millis();                 // reset first: a failed camera must
    if (cameraDelivers()) pingHealth();  // retry in 5 min, not spin
  }

  // A finished press series wins over the periodic slot: it is the frame
  // that shows what the adjustment actually did.
  if (online && uploadAfterPress && millis() - lastPressAt > PRESS_SETTLE_MS) {
    uploadAfterPress = false;
    lastUpload = millis();
    uploadFrame("press");
  } else if (online && millis() - lastUpload > UPLOAD_INTERVAL_MS) {
    lastUpload = millis();
    uploadFrame("periodic");
  }

  static bool on = false;
  static unsigned long t = 0;
  unsigned long now = millis();
  if (on && now - t > 1000) {         // 1 s lit ...
    on = false; t = now; digitalWrite(HEARTBEAT_PIN, HIGH);
  } else if (!on && now - t > 4000) { // ... 4 s dark
    on = true;  t = now; digitalWrite(HEARTBEAT_PIN, LOW);
  }
  delay(50);
}
