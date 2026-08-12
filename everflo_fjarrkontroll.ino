/* ============================================================
 *  EverFlo fjärrkontroll – XIAO ESP32-S3 Sense
 *  ------------------------------------------------------------
 *  Funktioner:
 *   - Captive portal för wifi-konfiguration (WiFiManager)
 *   - MJPEG-kamerastream (port 81) av flödesmätarens boll
 *   - Svensk webbsida (port 80) med stora +/− knappar
 *   - Motorstyrning: NEMA17+TMC2209 (huvudspår) eller
 *     28BYJ-48+ULN2003 (fallback) – välj med MOTOR_VAL
 *   - Friläge mellan justeringar (EN-pin / spolar av)
 *   - Mjuka gränser MIN_LAGE..MAX_LAGE, läge sparas i flash
 *   - Kamerasensor-PID skrivs i seriell logg vid start
 *
 *  Arduino IDE-inställningar:
 *   Kort:  "XIAO_ESP32S3"  (esp32 by Espressif, v3.x)
 *   PSRAM: "OPI PSRAM"  (krävs för kameran!)
 *   Bibliotek: "WiFiManager" (tzapu) via Library Manager
 *              "TMCStepper" endast om ANVAND_TMC_UART 1
 *
 *  Kalibrering: se README_koppling.md
 * ============================================================ */

#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiManager.h>          // tzapu – captive portal
#include <ESPmDNS.h>
#include <Preferences.h>
#include "esp_http_server.h"
#include "esp_log.h"

#define FW_VERSION "1.6"

/* ---------------- MOTORVAL ---------------- */
#define MOTOR_TMC 1               // NEMA17 + TMC2209 (STEP/DIR/EN)
#define MOTOR_ULN 2               // 28BYJ-48 + ULN2003
#define MOTOR_VAL MOTOR_TMC       // <-- byt vid behov

#define ANVAND_TMC_UART 0         // 1 = strömstyrning+äkta freewheel via UART
                                  //     (kräver TMCStepper-bibliotek + 1k-motstånd, se README)

/* ---------------- RÖRELSE ---------------- */
#define DEG_PER_TRYCK   15        // grader motoraxel per knapptryck.
                                  // Lego-mätning: ~15° ≈ 0,1 L med koaxial 1:1-koppling.
                                  // JUSTERA efter kalibrering mot bollen!
#define RIKTNING        1         // 1 eller -1 om + går åt fel håll
#define MIN_LAGE        0
#define MAX_LAGE        50        // mjukt tak i antal tryck från noll.
                                  // SÄTT till mammas ordinerade max efter kalibrering!
#define MIKROSTEG       8         // TMC2209 standalone: MS1=MS2=GND => 1/8
#define STEG_PAUS_US    2500      // µs mellan mikrosteg (lägre = snabbare)

/* ---------------- SÄKERHET ---------------- */
#define WEBB_PIN ""               // t.ex. "4711" => kräver ?pin=4711 på API-anrop.
                                  // Tomt = av (enklast för mamma; alla på hemnätet kan styra)

/* ---------------- KAMERA ---------------- */
#define KAMERA_VFLIP    0         // 1 om bilden är uppochner
#define KAMERA_HMIRROR  0         // 1 om spegelvänd

/* ---------------- PINNAR ---------------- */
#if MOTOR_VAL == MOTOR_TMC
  #define PIN_STEP D0
  #define PIN_DIR  D1
  #define PIN_EN   D2             // aktiv LÅG. HÖG = drivare av = friläge
  #define PIN_TMC_RX D7           // endast UART-läget
  #define PIN_TMC_TX D6
#else
  #define PIN_IN1 D0
  #define PIN_IN2 D1
  #define PIN_IN3 D2
  #define PIN_IN4 D3
#endif

#if ANVAND_TMC_UART
  #include <TMCStepper.h>
  #define R_SENSE 0.11f
  TMC2209Stepper tmc(&Serial1, R_SENSE, 0b00);
#endif

/* ---------------- KAMERA-PINNAR (XIAO ESP32-S3 Sense) ------- */
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

/* ---------------- GLOBALT ---------------- */
Preferences prefs;
volatile int lage = 0;            // nuvarande position i antal tryck
volatile bool upptagen = false;   // motor i rörelse
bool kameraOK = false;
httpd_handle_t ctrl_httpd = NULL;
httpd_handle_t stream_httpd = NULL;
volatile uint32_t stream_gen = 0;   // ny tittare sparkar ut den gamla
#define HJARTSLAG_PIN 21            // XIAO user-LED (aktiv låg): blink = lever

/* Loggring – senaste raderna nåbara via http://<ip>/log */
String loggbuf[40]; int loggidx = 0;
void logg(const String &s) {
  Serial.println(s);
  loggbuf[loggidx % 40] = s;
  loggidx++;
}

/* ============================================================
 *  MOTOR
 * ============================================================ */
#if MOTOR_VAL == MOTOR_TMC

int stegPerTryck() {              // mikrosteg per tryck
  return (int)(DEG_PER_TRYCK / (1.8f / MIKROSTEG) + 0.5f);
}
void motorInit() {
  pinMode(PIN_STEP, OUTPUT);
  pinMode(PIN_DIR,  OUTPUT);
  pinMode(PIN_EN,   OUTPUT);
  digitalWrite(PIN_EN, HIGH);     // starta i friläge
#if ANVAND_TMC_UART
  Serial1.begin(115200, SERIAL_8N1, PIN_TMC_RX, PIN_TMC_TX);
  tmc.begin();
  tmc.rms_current(600);           // mA – gott och väl för knappen, kör svalt
  tmc.microsteps(MIKROSTEG);
  tmc.ihold(0);                   // ingen hållström
  tmc.freewheel(1);               // äkta freewheel i stillestånd
#endif
}
void motorTaI()   { digitalWrite(PIN_EN, LOW);  delay(30); }
void motorSlapp() { digitalWrite(PIN_EN, HIGH); }           // friläge
void motorSteg(int riktning) {
  digitalWrite(PIN_DIR, (riktning * RIKTNING) > 0 ? HIGH : LOW);
  int n = stegPerTryck();
  for (int i = 0; i < n; i++) {
    digitalWrite(PIN_STEP, HIGH); delayMicroseconds(4);
    digitalWrite(PIN_STEP, LOW);  delayMicroseconds(STEG_PAUS_US);
  }
}

#else /* MOTOR_ULN – 28BYJ-48 halvsteg */

const uint8_t SEKV[8] = {0b0001,0b0011,0b0010,0b0110,0b0100,0b1100,0b1000,0b1001};
int sekvIdx = 0;
int stegPerTryck() {              // ~4096 halvsteg/varv => 11,38 steg per grad
  return (int)(DEG_PER_TRYCK * 4096.0f / 360.0f + 0.5f);
}
void skrivFas(uint8_t f) {
  digitalWrite(PIN_IN1, f & 1); digitalWrite(PIN_IN2, (f>>1) & 1);
  digitalWrite(PIN_IN3, (f>>2) & 1); digitalWrite(PIN_IN4, (f>>3) & 1);
}
void motorInit() {
  pinMode(PIN_IN1, OUTPUT); pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_IN3, OUTPUT); pinMode(PIN_IN4, OUTPUT);
  skrivFas(0);                    // spolar av = "friläge" (växellådan bromsar ändå)
}
void motorTaI()   { }
void motorSlapp() { skrivFas(0); }
void motorSteg(int riktning) {
  int n = stegPerTryck();
  int d = (riktning * RIKTNING) > 0 ? 1 : -1;
  for (int i = 0; i < n; i++) {
    sekvIdx = (sekvIdx + d + 8) % 8;
    skrivFas(SEKV[sekvIdx]);
    delayMicroseconds(STEG_PAUS_US);
  }
}
#endif

/* Gemensam rörelse med gränser + spara läge */
bool flytta(int riktning) {
  if (upptagen) return false;
  int nytt = lage + riktning;
  if (nytt < MIN_LAGE || nytt > MAX_LAGE) return false;
  upptagen = true;
  motorTaI();
  motorSteg(riktning);
  motorSlapp();
  lage = nytt;
  prefs.putInt("lage", lage);
  logg(String("Lage: ") + lage);
  upptagen = false;
  return true;
}

/* ============================================================
 *  KAMERA
 * ============================================================ */
bool kameraInit() {
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
  c.frame_size   = FRAMESIZE_VGA;   // 640x480 – lagom för bollen
  c.jpeg_quality = 12;
  c.fb_count     = 2;
  c.fb_location  = CAMERA_FB_IN_PSRAM;
  c.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;  // pausa när ingen tittar => inga FB-OVF

  if (esp_camera_init(&c) != ESP_OK) return false;

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    const char *namn = "okänd";
    if      (s->id.PID == 0x3660) namn = "OV3660 (nya kameran)";
    else if (s->id.PID == 0x26)   namn = "OV2640 (äldre kameran)";
    else if (s->id.PID == 0x5640) namn = "OV5640";
    Serial.printf("Kamerasensor PID=0x%04x -> %s\n", s->id.PID, namn);
    s->set_vflip(s, KAMERA_VFLIP);
    s->set_hmirror(s, KAMERA_HMIRROR);
  }
  return true;
}

/* ============================================================
 *  WEBB
 * ============================================================ */
static const char SIDA[] = R"HTML(
<!DOCTYPE html><html lang="sv"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Syrgas – fjärrkontroll</title>
<style>
 body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0;background:#f4f4f2;
      display:flex;flex-direction:column;align-items:center;gap:14px;padding:12px}
 h1{font-size:1.3rem;margin:6px 0 0;color:#333}
 img{width:100%;max-width:480px;border-radius:12px;background:#000;min-height:200px}
 .lage{font-size:1.6rem;color:#333}
 .lage b{font-size:2.2rem}
 button{width:100%;max-width:480px;font-size:2.4rem;padding:26px 0;border:none;
        border-radius:16px;color:#fff;font-weight:700;cursor:pointer}
 #plus{background:#1c8a4c}
 #minus{background:#4a6fa5}
 button:disabled{opacity:.45}
 #msg{min-height:1.4em;font-size:1.1rem;color:#a33}
 .liten{font-size:.85rem;color:#888;margin-top:18px}
</style></head><body>
<h1>Syrgas – fjärrkontroll</h1>
<img id="cam" alt="Kamerabild laddas...">
<div class="lage">Läge: <b id="lage">–</b></div>
<button id="plus" onclick="tryck('plus')">+ MER</button>
<button id="minus" onclick="tryck('minus')">&minus; MINDRE</button>
<div id="msg"></div>
<div class="liten"><a href="#" onclick="nollstall();return false">Nollställ räknare (tekniker)</a> · v%VER%</div>
<script>
const PIN='%PIN%'; const q = PIN ? ('?pin='+PIN) : '';
document.getElementById('cam').src = 'http://'+location.hostname+':81/stream';
async function status(){
  try{ const j = await (await fetch('/api/status'+q)).json();
       document.getElementById('lage').textContent = j.lage; }catch(e){}
}
async function tryck(op){
  const b1=document.getElementById('plus'), b2=document.getElementById('minus');
  b1.disabled=b2.disabled=true;
  document.getElementById('msg').textContent='';
  try{
    const j = await (await fetch('/api/'+op+q)).json();
    document.getElementById('lage').textContent = j.lage;
    if(!j.ok) document.getElementById('msg').textContent='Gränsen är nådd';
  }catch(e){ document.getElementById('msg').textContent='Ingen kontakt'; }
  b1.disabled=b2.disabled=false;
}
async function nollstall(){
  if(!confirm('Nollställa räknaren? (endast vid ominstallation)'))return;
  const j = await (await fetch('/api/nollstall'+q)).json();
  document.getElementById('lage').textContent=j.lage;
}
status(); setInterval(status,10000);
</script></body></html>
)HTML";

bool pinOK(httpd_req_t *req) {
  if (strlen(WEBB_PIN) == 0) return true;
  char buf[64]; char val[16] = "";
  if (httpd_req_get_url_query_str(req, buf, sizeof(buf)) == ESP_OK)
    httpd_query_key_value(buf, "pin", val, sizeof(val));
  return strcmp(val, WEBB_PIN) == 0;
}

esp_err_t svaraJson(httpd_req_t *req, bool ok) {
  char b[64];
  snprintf(b, sizeof(b), "{\"ok\":%s,\"lage\":%d,\"max\":%d}",
           ok ? "true" : "false", lage, MAX_LAGE);
  httpd_resp_set_type(req, "application/json");
  return httpd_resp_send(req, b, HTTPD_RESP_USE_STRLEN);
}

esp_err_t h_index(httpd_req_t *req) {
  String s(SIDA);
  s.replace("%PIN%", WEBB_PIN);
  s.replace("%VER%", FW_VERSION);
  httpd_resp_set_type(req, "text/html; charset=utf-8");
  return httpd_resp_send(req, s.c_str(), s.length());
}
esp_err_t h_plus(httpd_req_t *req)  { if(!pinOK(req)) return httpd_resp_send_err(req,HTTPD_403_FORBIDDEN,"pin"); return svaraJson(req, flytta(+1)); }
esp_err_t h_minus(httpd_req_t *req) { if(!pinOK(req)) return httpd_resp_send_err(req,HTTPD_403_FORBIDDEN,"pin"); return svaraJson(req, flytta(-1)); }
esp_err_t h_noll(httpd_req_t *req)  { if(!pinOK(req)) return httpd_resp_send_err(req,HTTPD_403_FORBIDDEN,"pin"); lage=0; prefs.putInt("lage",0); return svaraJson(req,true); }
esp_err_t h_status(httpd_req_t *req){ return svaraJson(req, true); }
esp_err_t h_log(httpd_req_t *req) {
  String s;
  for (int i = 0; i < 40; i++) {
    int k = (loggidx + i) % 40;
    if (loggbuf[k].length()) { s += loggbuf[k]; s += "\n"; }
  }
  httpd_resp_set_type(req, "text/plain; charset=utf-8");
  return httpd_resp_send(req, s.c_str(), s.length());
}
esp_err_t h_still(httpd_req_t *req) {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) return httpd_resp_send_500(req);
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  esp_err_t r = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return r;
}

/* MJPEG-stream */
esp_err_t h_stream(httpd_req_t *req) {
  char part[96];
  uint32_t min_gen = ++stream_gen;   // jag är nu enda giltiga tittaren
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
      break;                       // klienten stängde
    }
    esp_camera_fb_return(fb);
  }
  return ESP_OK;
}

void startaWebb() {
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port = 80;
  cfg.max_uri_handlers = 8;
  if (httpd_start(&ctrl_httpd, &cfg) == ESP_OK) {
    httpd_uri_t u;
    u = {.uri="/",              .method=HTTP_GET, .handler=h_index,  .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/api/plus",      .method=HTTP_GET, .handler=h_plus,   .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/api/minus",     .method=HTTP_GET, .handler=h_minus,  .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/api/nollstall", .method=HTTP_GET, .handler=h_noll,   .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/api/status",    .method=HTTP_GET, .handler=h_status, .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/log",           .method=HTTP_GET, .handler=h_log,    .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
    u = {.uri="/bild",          .method=HTTP_GET, .handler=h_still,  .user_ctx=NULL}; httpd_register_uri_handler(ctrl_httpd,&u);
  }
  if (kameraOK) {
    httpd_config_t cfg2 = HTTPD_DEFAULT_CONFIG();
    cfg2.server_port = 81;
    cfg2.ctrl_port   = 32769;      // egen kontrollport, krockar annars med 80-servern
    if (httpd_start(&stream_httpd, &cfg2) == ESP_OK) {
      httpd_uri_t u = {.uri="/stream", .method=HTTP_GET, .handler=h_stream, .user_ctx=NULL};
      httpd_register_uri_handler(stream_httpd, &u);
    }
  }
}

/* ============================================================
 *  SJÄLVLÄKANDE WIFI (drift)
 *  Bootvägen läks av WiFiManager; detta täcker tappat nät EFTER
 *  lyckad start: 3 återanslutningsförsök med 15 s mellanrum,
 *  därefter omstart (WiFiManager tar då över med portal vid behov).
 * ============================================================ */
unsigned long wifiSenast = 0;
int wifiForsok = 0;
void wifiVakt() {
  if (WiFi.status() == WL_CONNECTED) { wifiForsok = 0; return; }
  unsigned long nu = millis();
  if (nu - wifiSenast < 15000) return;
  wifiSenast = nu;
  wifiForsok++;
  if (wifiForsok <= 3) {
    logg(String("Wifi borta - aterforsok ") + wifiForsok + "/3");
    WiFi.reconnect();
  } else {
    logg("Wifi kunde inte aterstallas - startar om");
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
  pinMode(HJARTSLAG_PIN, OUTPUT);
  digitalWrite(HJARTSLAG_PIN, HIGH);   // släckt (aktiv låg)
  esp_log_level_set("cam_hal", ESP_LOG_ERROR);  // tysta ofarliga FB-OVF-varningar
  logg("=== EverFlo fjarrkontroll v" FW_VERSION " startar ===");

  prefs.begin("everflo", false);
  lage = prefs.getInt("lage", 0);
  Serial.printf("Sparat lage: %d (max %d)\n", lage, MAX_LAGE);

  motorInit();
  Serial.printf("Motorlage: %s, %d grader/tryck\n",
                MOTOR_VAL==MOTOR_TMC ? "NEMA17+TMC2209" : "28BYJ-48+ULN2003",
                DEG_PER_TRYCK);

  esp_log_level_set("cam_hal", ESP_LOG_NONE);  // tysta ofarliga FB-OVF-rader
  kameraOK = kameraInit();
  logg(kameraOK ? "Kamera OK" : "KAMERA MISSLYCKADES (kolla PSRAM-installningen!)");

  // Captive portal: forsta gangen (eller om sparat wifi saknas) startar
  // XIAO en egen hotspot "Syrgas-setup". Anslut med telefonen, valj
  // hemmets wifi och ange losenord. Sen ansluter den sjalv for alltid.
  WiFiManager wm;
  wm.setHostname("syrgas");
  wm.setConnectTimeout(15);        // per forsok
  wm.setConnectRetries(3);         // tre forsok innan portal
  wm.setConfigPortalTimeout(120);  // portal max 2 min, sen omstart+nytt forsok
  if (!wm.autoConnect("Syrgas-setup")) {
    logg("Wifi misslyckades - startar om och forsoker igen");
    delay(500);
    ESP.restart();
  }
  logg(String("Ansluten! IP: ") + WiFi.localIP().toString());

  if (MDNS.begin("syrgas")) Serial.println("Adress: http://syrgas.local");

  startaWebb();
  Serial.println("Webbsida: port 80, stream: port 81");
  logg("=== Redo ===");
}

void loop() {
  wifiVakt();
  static bool pa = false;
  static unsigned long t = 0;
  unsigned long nu = millis();
  if (pa && nu - t > 1000) {        // 1 s tand ...
    pa = false; t = nu; digitalWrite(HJARTSLAG_PIN, HIGH);
  } else if (!pa && nu - t > 4000) { // ... 4 s vila
    pa = true;  t = nu; digitalWrite(HJARTSLAG_PIN, LOW);
  }
  delay(50);
}
