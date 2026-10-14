# MÃ NGUỒN DỰ ÁN FTP CLIENT–SERVER

Workspace `source` chứa hai module độc lập: Electron desktop client và NestJS API server. Client quản lý giao diện/tệp cục bộ; server sở hữu FTP socket, remote session và transfer. Hai package giao tiếp hoàn toàn qua HTTP và WebSocket, không import source code của nhau.

---

## 🎯 MỤC TIÊU

- Tách frontend desktop và backend thành hai dịch vụ độc lập.
- Giữ nguyên giao diện React của source ban đầu.
- Chuyển kết nối FTP khỏi Electron sang NestJS API.
- Truyền file lớn theo stream/backpressure, không giữ toàn bộ file trong RAM.
- Hỗ trợ nhiều client/session đồng thời; một data transfer trên mỗi FTP session.
- Chuẩn hóa validation, success/error response và tiến độ realtime.

---

## 🧠 KIẾN TRÚC

```text
React renderer
    │ window.ftp / window.local / IPC
    ▼
Preload bridge ── Electron main ── Local filesystem
                       │
                       ├── HTTP /api ─────────────► NestJS controllers
                       └── ws /transfers ◄──────── Transfer gateway
                                                        │
                                                 Session / FTP core
                                                        │
                                            TCP control + PASV data
                                                        ▼
                                                    FTP server
```

Preload expose `window.ftp`, `window.local` và `window.desktop`. Electron main thực hiện REST/WebSocket và stream file local. NestJS xử lý session, validation, FTP command queue và data connection.

Khi client B upload 10 GB và client C upload 200 MB, hai session chạy đồng thời. C không phải đợi B; cả hai chỉ chia sẻ băng thông/CPU/network của backend và FTP server.

---

## ⚙️ CÔNG NGHỆ SỬ DỤNG

| Thành phần | Công nghệ | Trách nhiệm |
| --- | --- | --- |
| Workspace | pnpm 10.28.2, TypeScript | Quản lý client/server packages |
| Client | Electron, React, electron-vite | UI, local filesystem, HTTP stream |
| Server | NestJS, Express | REST API và FTP session |
| Validation | Zod, nestjs-zod | Body/query/header validation |
| Realtime | NestJS `WsAdapter`, `ws` | Transfer progress qua WebSocket chuẩn |
| FTP | Node.js TCP sockets, PASV | Control command và data streams |
| API docs | Swagger | Tài liệu endpoint trực tiếp |
| Tests | Jest, Supertest, Node test runner | Unit, integration, end-to-end |

---

## 📦 CẤU TRÚC WORKSPACE

```text
source/
├── README.md
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── client/
│   ├── README.md
│   ├── .env.example
│   ├── src/
│   └── test/
└── server/
    ├── README.md
    ├── .env.example
    ├── src/
    └── test/
```

- [Chi tiết module client](client/README.md)
- [Chi tiết module server](server/README.md)

---

## 🚀 HƯỚNG DẪN CÀI ĐẶT VÀ CHẠY

### Yêu cầu

- Node.js 24 trở lên.
- pnpm 10.28.2.
- Môi trường desktop để chạy Electron.
- FTP server hỗ trợ passive mode cho demo thực tế.

### Cài dependency

Từ thư mục gốc repository:

```powershell
pnpm --dir source install
Copy-Item source/server/.env.example source/server/.env
```

### Chạy server

```powershell
pnpm --dir source/server start:dev
```

### Chạy client

Mở terminal thứ hai:

```powershell
$env:FTP_API_BASE_URL = 'http://127.0.0.1:3000/api'
pnpm --dir source/client dev
```

Nếu backend chạy trên máy A, thay `127.0.0.1` bằng IP/hostname của máy A và mở firewall cho cổng `3000`.

### Kiểm thử và build

```powershell
pnpm --dir source test
pnpm --dir source build
pnpm --dir source lint
```

Build output: `server/dist` và `client/out`. `lint` hiện chạy TypeScript typecheck bằng `tsc --noEmit`.

---

## 🔧 BIẾN MÔI TRƯỜNG

| Biến | Process | Mặc định/chức năng |
| --- | --- | --- |
| `PORT` | Server | `3000`; REST và WebSocket dùng chung listener |
| `CLIENT_ORIGIN` | Server | Origin CORS được phép; bỏ trống nếu không dùng browser origin ngoài |
| `FTP_SESSION_IDLE_TIMEOUT_MS` | Server | `1800000` ms, tương đương 30 phút |
| `FTP_API_BASE_URL` | Electron main | `http://127.0.0.1:3000/api` |
| `FTP_WS_BASE_URL` | Electron main | Tùy chọn; nếu thiếu sẽ suy ra từ API URL |

Client `.env.example` là tài liệu tham khảo; đặt biến trong process environment khi khởi động Electron. `VITE_API_BASE_URL` không được sử dụng.

---

## 🔗 REST API

Base URL mặc định: `http://localhost:3000/api`. Swagger: `http://localhost:3000/api/docs`.

| Method | Path dưới `/api` | Input | Kết quả |
| --- | --- | --- | --- |
| GET | `/health` | Không | `{ status: "ok" }` |
| POST | `/ftp/sessions` | `{ host, port }` | Tạo session |
| GET | `/ftp/sessions/:id` | Không | Session snapshot |
| POST | `/ftp/sessions/:id/login` | `{ username, password }` | Authenticated session |
| DELETE | `/ftp/sessions/:id` | Không | Disconnect |
| GET | `/ftp/sessions/:id/files` | Query `path` tùy chọn | Danh sách remote entries |
| GET | `/ftp/sessions/:id/pwd` | Không | Working directory |
| POST | `/ftp/sessions/:id/cwd` | `{ path }` | Chuyển thư mục |
| POST | `/ftp/sessions/:id/cdup` | Không | Chuyển lên thư mục cha |
| POST | `/ftp/sessions/:id/directories` | `{ name }` | Tạo thư mục |
| PATCH | `/ftp/sessions/:id/entries` | `{ from, to }` | Rename/move |
| DELETE | `/ftp/sessions/:id/files` | Query `path` | Xóa file |
| DELETE | `/ftp/sessions/:id/directories` | Query `path`, `recursive` | Xóa thư mục |
| POST | `/ftp/sessions/:id/uploads` | Binary body + headers | `{ transferId }` |
| GET | `/ftp/sessions/:id/downloads` | Query `transferId`, `remotePath` | Binary stream |
| DELETE | `/ftp/transfers/:transferId` | Transfer ID | Hủy và chờ settle |

POST thành công trả HTTP `201`; GET/PATCH/DELETE trả HTTP `200`. Download thành công trả binary, không dùng JSON envelope.

### Upload headers

```text
Content-Type: application/octet-stream
x-transfer-id: <unique-id>
x-remote-path-encoded: encodeURIComponent(remotePath)
Content-Length: <optional-byte-count>
```

Ví dụ `/demo/ báo cáo %.txt` được encode thành `%2Fdemo%2F%20b%C3%A1o%20c%C3%A1o%20%25.txt`. Header legacy `x-remote-path` bị từ chối với HTTP `422` để tránh làm hỏng Unicode/khoảng trắng.

---

## 📬 FORMAT RESPONSE

### Thành công

```json
{
  "success": true,
  "data": { "status": "ok" },
  "meta": { "timestamp": "2026-10-10T00:00:00.000Z" }
}
```

Response danh sách có thể bổ sung `meta.total`.

### Lỗi chung

```json
{
  "success": false,
  "error": {
    "statusCode": 404,
    "code": "FTP_SESSION_NOT_FOUND",
    "message": "Không tìm thấy phiên FTP"
  },
  "meta": {
    "timestamp": "2026-10-10T00:00:00.000Z",
    "requestId": "example-request-id",
    "path": "/api/ftp/sessions/missing"
  }
}
```

### Validation HTTP 422

```json
{
  "success": false,
  "error": {
    "statusCode": 422,
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "field": "host", "path": ["host"], "code": "too_small", "message": "Host không được để trống" },
      { "field": "port", "path": ["port"], "code": "too_big", "message": "Port phải từ 1 đến 65535" }
    ]
  },
  "meta": { "timestamp": "...", "requestId": "...", "path": "/api/ftp/sessions" }
}
```

Server echo `x-request-id` hợp lệ hoặc tự sinh request ID mới. Thông tin nhạy cảm như mật khẩu không được đưa vào response/log lỗi.

---

## 📡 WEBSOCKET TRANSFER EVENTS

Kết nối sau khi tạo FTP session:

```javascript
const socket = new WebSocket(
  `ws://localhost:3000/transfers?sessionId=${encodeURIComponent(sessionId)}`
)
```

Gateway nằm ngoài `/api`, dùng WebSocket chuẩn, không dùng Socket.IO. Session ID thiếu/trùng/không hợp lệ sẽ đóng với code `1008`.

```json
{
  "event": "transfer.progress",
  "data": {
    "transferId": "demo-upload",
    "direction": "upload",
    "transferredBytes": 512,
    "totalBytes": 1024,
    "percentage": 50,
    "bytesPerSecond": 2048
  }
}
```

Event hỗ trợ:

- `transfer.progress`
- `transfer.completed`
- `transfer.cancelled`
- `transfer.failed`

`direction` là `upload` hoặc `download`. Khi không biết tổng dung lượng, `totalBytes` và `percentage` là `null`.

---

## 🧪 DEMO VÀ KIỂM THỬ

### Kiểm thử tự động

```powershell
pnpm --dir source test
```

Kết quả xác minh gần nhất:

- Server: 216/216 tests, 24 suites.
- Client: 58/58 tests.
- Workspace test/build/lint: thành công.

### Demo với FTP server thật

1. Khởi động backend và client.
2. Kiểm tra `/api/health` và Swagger.
3. Connect/login vào FTP server.
4. List/PWD và tạo một thư mục demo riêng.
5. Upload file, theo dõi progress và tải file xuống để so sánh byte.
6. Bắt đầu transfer lớn thứ hai rồi cancel.
7. Kiểm tra session còn dùng được hoặc reconnect nếu server retire session.
8. Rename, xóa file hoàn thành, xóa partial file do cancel, xóa thư mục demo và disconnect.

Không commit credential FTP. Chỉ xóa các file/thư mục do chính demo tạo.

---

## 📝 GIỚI HẠN VÀ GHI CHÚ

- Server hỗ trợ plain FTP/PASV, chưa hỗ trợ FTPS/SFTP.
- Session mặc định hết hạn sau 30 phút không hoạt động.
- Một FTP session chỉ có một data operation; session khác nhau vẫn hoạt động đồng thời.
- Sau ABOR, session chỉ tái sử dụng khi FTP control replies đến theo thứ tự trước `NOOP 200`.
- FTP không có reply ID; khi reply ordering không chắc chắn hoặc cancel timeout, server đóng session để tránh thao tác nhầm file.
- Observer WebSocket quá chậm với buffer trên 1 MiB sẽ bị ngắt.
- Cần cấu hình firewall/NAT để backend truy cập được passive data ports của FTP server.

Xem thêm [README client](client/README.md) và [README server](server/README.md).
