# Doowise Play

เว็บ React สำหรับค้นหาและเล่นรายการหนังจาก `Doowiseplay-movies.csv` และ `Doowiseplay-movies.m3u`

## เริ่มใช้งาน

```powershell
npm install
npm run build
npm start
```

จากนั้นเปิด `http://127.0.0.1:4173`

ระหว่างพัฒนาใช้ `npm run dev` ซึ่งเปิด Vite ผ่านเซิร์ฟเวอร์ Node ตัวเดียวกัน

## โครงสร้าง

- React + Vite สำหรับ UI
- Express API สำหรับค้นหารายการหนัง
- Media proxy แบบ URL ลงลายเซ็นภายในโปรเซส เพื่อส่ง Referer/User-Agent ตามไฟล์เดิมและ rewrite HLS manifest
- Proxy รับเฉพาะรายการใน catalog และ resource URL ที่เซิร์ฟเวอร์สร้างลายเซ็นให้ ไม่ได้เปิดเป็น arbitrary URL proxy
- ตรวจ metadata ของทั้ง 4 แหล่งทุก 15 นาที ดาวน์โหลดเฉพาะแหล่งที่เปลี่ยน เพิ่มรายการใหม่ และตัดรายการซ้ำแบบอัตโนมัติ (ไม่ลบรายการเดิม)
- หน้า React รับการเปลี่ยนแปลงผ่าน Server-Sent Events จึงอัปเดตรายการได้โดยไม่ต้องรีเฟรชหน้า

ข้อมูลต้นทางและสถานะการซิงก์อยู่ในโฟลเดอร์ `data/` ส่วนรหัสสมาชิกอยู่ใน `.env.local` ซึ่งถูกกันออกจาก Git แล้ว

## ตั้งค่าการซิงก์

```dotenv
DOOWISE_MEMBER_ID=รหัสสมาชิก
DOOWISE_SYNC_INTERVAL_MINUTES=15
```

เซิร์ฟเวอร์ตรวจครั้งแรกทันทีที่เปิด จากนั้นตรวจซ้ำตามช่วงเวลาที่กำหนด การซิงก์ทำงานเฉพาะตอนที่ `npm start` หรือ `npm run dev` ยังเปิดอยู่
# EntertainmentComplex
