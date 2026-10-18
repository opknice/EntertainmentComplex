# OTT sport all — 18 ตุลาคม 2026

## ปัญหาที่แก้

ผู้ใช้ยืนยันว่า `MonoMax | Event 1` และ `MonoMax | Event 2` เล่นได้ใน OTT Navigator
แต่เล่นไม่ได้บนเว็บ production จึงตรวจสองช่องเดียวกันโดยตรง และตรวจ HTTP ครบ 20 ช่องในหมวด

ก่อนแก้: master playlist ตอบ 200 แต่ URL ลูกที่ `lookontv.net:2095` ตอบ 302
ไปยัง public HTTP IP บนพอร์ต 2005 การตาม redirect อัตโนมัติของ Worker ไม่ผ่าน
ตัวปรับเส้นทาง HTTP-IP ที่มีอยู่ จึงได้รับ Cloudflare error 1003 / HTTP 403
ขณะที่ request ตรงจากเครื่อง local ตาม redirect แล้วได้ HLS 200
นี่เป็นปัญหาเส้นทางส่งต่อ ไม่ใช่หลักฐานว่าสัญญาณหมดอายุ

## การแก้ไข

- ให้ Worker เป็นเจ้าของ redirect chain โดยตรง ใช้ตัวปรับเส้นทาง HTTP-IP ทุก hop
- เก็บ URL ต้นทางสุดท้ายแยกจาก DNS alias สำหรับส่งข้อมูล เพื่อ resolve HLS key/segment
  และ DASH resource ตาม canonical URL ที่ถูกต้อง
- ตรวจปลายทางทุก hop ไม่ยอมรับ private IP/โปรโตคอลอื่น จำกัด 20 redirects ตาม fetch
  และปล่อย body ของ redirect ก่อนเปิด request ถัดไป
- รักษา HEAD/Range/User-Agent/Referer และลบ authentication เมื่อ redirect ข้าม origin
- ไม่เปลี่ยน URL ช่อง ไม่ค้น/สร้าง token หรือ DRM key และไม่ลดคุณภาพเพื่อกลบข้อผิดพลาด

## การยืนยัน

- Node regressions ผ่าน 49/49, Worker TypeScript และ deploy dry run ผ่าน
- Deploy Worker รุ่น `7bb7a13d-25f0-4270-b7b2-b255091dc4b8` แล้ว
  รุ่นก่อนแก้สำหรับ rollback คือ `3977c821-ff7d-4e5f-93bd-10de4b319cd5`
- Chrome เปิดการ์ดบนเว็บ production จริงโดยไม่มี fixture แทนสตรีม และไม่มี flag ข้าม autoplay:
  Event 1 และ Event 2 ถอดรหัสภาพ 1920×1080 ได้ เวลาเดินและมี decoded frames
- รายงาน local อยู่ใน `reports/ott-audit/sport-all-2026-10-18.json`,
  `sport-all-after-2026-10-18.json` และ `sport-all-confirmed-after.json`
  ไม่เผยแพร่ URL รับชม โทเคน หรือรหัสสิทธิ์

## ขอบเขตที่ยังไม่สำเร็จ

ไม่ถือว่าทั้งหมวด 20 ช่องแก้ครบแล้ว: Event 3 ยังมี network error, Event 4/VNL 1–5
ยังมีการปฏิเสธคำขอ, Event 10–15 ยังมีปัญหาเส้นทาง proxy/ต้นทาง และ sp 1–5 ตอบ 404
ทั้ง proxy และตรง ณ เวลาตรวจ ข้อผิดพลาดเหล่านี้ไม่ยืนยันอายุสัญญาณ
ระหว่างตรวจพบ Event 1 ตอบ 509 ชั่วคราวด้วย แต่ตรวจภาพซ้ำแบบทีละช่องแล้วเล่นได้

จำนวนช่องที่ยืนยันว่าสัญญาณหมดอายุจากหลักฐานตรง: **0**
การตรวจ HTTP ของช่องอื่นไม่เท่ากับการยืนยันภาพจริง และผลสตรีมสดอาจเปลี่ยนตามเวลา

ข้ออ้างอิงแพลตฟอร์ม:
[การทำงานของ fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/),
[custom port support](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#allow-specifying-a-custom-port-when-making-a-subrequest-with-the-fetch-api)
