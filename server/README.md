# MODULE SERVER — NESTJS FTP API

Server cung cấp REST API và WebSocket để nhiều Electron client thao tác với FTP server. Server sở hữu FTP control/data socket, session và transfer; file cục bộ luôn thuộc về máy chạy client.

---

## 🎯 MỤC TIÊU

Server chịu trách nhiệm:

- Kết nối và đăng nhập FTP theo từng session.
- Cung cấp API quản lý file/thư mục từ xa.
- Stream upload/download có backpressure.
- Phát tiến độ transfer bằng WebSocket chuẩn.
- Validate body/query/header bằng Zod và trả lỗi thống nhất.
- Bảo vệ thứ tự FTP command, giới hạn một data operation trên mỗi session.
- Dọn session khi disconnect, timeout, transport failure hoặc shutdown.

---

## ⚙️ CÔNG NGHỆ SỬ DỤNG

| Thành phần | Công nghệ |
| --- | --- |
| Ngôn ngữ | TypeScript |
| Framework | NestJS + Express adapter |
| Validation | Zod, nestjs-zod |
| Realtime | NestJS WebSocket + `ws` adapter |
| FTP core | Node.js `net.Socket`, PASV data streams |
| API docs | Swagger/OpenAPI |
| Kiểm thử | Jest, Supertest, TCP/FTP fixtures |

Server không sử dụng database; session được lưu trong RAM. Restart server sẽ làm mọi session ID hết hiệu lực.

---

## 🔧 CẤU HÌNH

```powershell
Copy-Item source/server/.env.example source/server/.env
```

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PORT` | `3000` | Cổng dùng chung cho REST API và WebSocket |
| `CLIENT_ORIGIN` | Không bật CORS origin | Origin HTTP được phép, ví dụ `http://localhost:5173` |
| `FTP_SESSION_IDLE_TIMEOUT_MS` | `1800000` | Thời gian session không hoạt động, mặc định 30 phút |

Giá trị timeout phải là số dương hữu hạn; giá trị không hợp lệ sẽ dùng mặc định. Data operation đang chạy giữ session sống và bắt đầu lại đủ thời gian timeout sau khi kết thúc.

---

## 🚀 HƯỚNG DẪN CHẠY

```powershell
pnpm --dir source install
Copy-Item source/server/.env.example source/server/.env
pnpm --dir source/server start:dev
```

Địa chỉ mặc định:

- REST API: `http://localhost:3000/api`
- Health: `http://localhost:3000/api/health`
- Swagger: `http://localhost:3000/api/docs`
- WebSocket: `ws://localhost:3000/transfers?sessionId=<session-id>`

```powershell
pnpm --dir source/server start:dev
pnpm --dir source/server start
pnpm --dir source/server test
pnpm --dir source/server test:e2e
pnpm --dir source/server build
pnpm --dir source/server lint
```

Sau khi build có thể chạy `node source/server/dist/main.js` với biến môi trường đã cấu hình.

---

## 🔗 REST API

| Method | Endpoint | Input/chức năng |
| --- | --- | --- |
| GET | `/api/health` | Kiểm tra server |
| POST | `/api/ftp/sessions` | `{ host, port }`, tạo FTP session |
| GET | `/api/ftp/sessions/:id` | Lấy trạng thái session |
| POST | `/api/ftp/sessions/:id/login` | `{ username, password }` |
| DELETE | `/api/ftp/sessions/:id` | Disconnect và xóa session |
| GET | `/api/ftp/sessions/:id/files` | List; query `path` tùy chọn |
| GET | `/api/ftp/sessions/:id/pwd` | Lấy working directory |
| POST | `/api/ftp/sessions/:id/cwd` | `{ path }` |
| POST | `/api/ftp/sessions/:id/cdup` | Chuyển lên thư mục cha |
| POST | `/api/ftp/sessions/:id/directories` | `{ name }`, tạo thư mục |
| PATCH | `/api/ftp/sessions/:id/entries` | `{ from, to }`, rename/move |
| DELETE | `/api/ftp/sessions/:id/files` | Query `path`, xóa file |
| DELETE | `/api/ftp/sessions/:id/directories` | Query `path`, `recursive` tùy chọn |
| POST | `/api/ftp/sessions/:id/uploads` | Raw binary upload |
| GET | `/api/ftp/sessions/:id/downloads` | Query `transferId`, `remotePath` |
| DELETE | `/api/ftp/transfers/:transferId` | Hủy và chờ transfer settle |

Remote operation yêu cầu session đã authenticated. LIST, recursive delete, upload và download dùng chung data-operation lease; data request thứ hai trên cùng session trả HTTP `409`.

### Upload contract

- `Content-Type: application/octet-stream`
- `x-transfer-id`: `[A-Za-z0-9_-]{1,128}`
- `x-remote-path-encoded`: `encodeURIComponent(remotePath)`
- `Content-Length`: tùy chọn

Header raw `x-remote-path` bị từ chối để tránh mất Unicode hoặc khoảng trắng. Download thành công trả binary stream, không bọc JSON.

---

## 📬 ĐỊNH DẠNG RESPONSE

Thành công:

```json
{
  "success": true,
  "data": {},
  "meta": { "timestamp": "2026-10-10T00:00:00.000Z" }
}
```

Lỗi chung:

```json
{
  "success": false,
  "error": {
    "statusCode": 404,
    "code": "FTP_SESSION_NOT_FOUND",
    "message": "Không tìm thấy phiên FTP"
  },
  "meta": { "timestamp": "...", "requestId": "...", "path": "..." }
}
```

Validation lỗi trả HTTP `422`:

```json
{
  "success": false,
  "error": {
    "statusCode": 422,
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "field": "port", "path": ["port"], "code": "too_big", "message": "Port phải từ 1 đến 65535" }
    ]
  },
  "meta": { "timestamp": "...", "requestId": "...", "path": "..." }
}
```

| HTTP | Code thường gặp |
| --- | --- |
| 401 | `FTP_AUTH_FAILED` |
| 404 | `FTP_SESSION_NOT_FOUND`, `FTP_TRANSFER_NOT_FOUND` |
| 409 | `FTP_SESSION_CONFLICT`, `FTP_TRANSFER_CANCELLED` |
| 422 | `VALIDATION_ERROR` |
| 502 | `FTP_SERVER_ERROR` |
| 503 | `FTP_CONNECTION_FAILED` |
| 504 | `FTP_TIMEOUT`, `FTP_TRANSFER_CANCEL_TIMEOUT` |

---

## 📡 WEBSOCKET

Server dùng WebSocket chuẩn qua NestJS `WsAdapter` và `ws`, **không dùng Socket.IO**:

```text
ws://localhost:3000/transfers?sessionId=<URL-encoded-session-id>
```

Gateway không có prefix `/api`. Session ID không hợp lệ bị đóng với code `1008`. Event gồm `transfer.progress`, `transfer.completed`, `transfer.cancelled`, `transfer.failed`.

```json
{
  "event": "transfer.progress",
  "data": {
    "transferId": "upload-1",
    "direction": "upload",
    "transferredBytes": 512,
    "totalBytes": 1024,
    "percentage": 50,
    "bytesPerSecond": 2048
  }
}
```

Observer có buffer vượt 1 MiB sẽ bị ngắt để tránh tích lũy dữ liệu vô hạn.

---

## 📦 CẤU TRÚC MODULE

```text
server/
├── README.md
├── .env.example
├── package.json
├── src/
│   ├── common/                # Envelope, exception, validation
│   ├── health/                # Health endpoint
│   ├── ftp/
│   │   ├── core/              # FTP control/data implementation
│   │   ├── schemas/           # Zod schemas
│   │   └── transfer/          # HTTP transfer + WebSocket
│   └── main.ts
└── test/                      # E2E và TCP/FTP fixtures
```

---

## 🧪 KIỂM THỬ

```powershell
pnpm --dir source/server test
pnpm --dir source/server test:e2e
```

Test suite bao phủ parser, command queue, operation serialization, session lifecycle, REST envelope/422, path validation, streaming, cancellation, LIST reset và WebSocket.

---

## 📝 GIỚI HẠN VÀ TƯƠNG THÍCH FTP

- Chỉ hỗ trợ plain FTP/PASV; chưa hỗ trợ FTPS hoặc SFTP.
- Firewall phải cho phép backend truy cập control port và passive data port.
- Sau ABOR, session chỉ được tái sử dụng khi transfer/ABOR reply đến trước `NOOP 200` theo thứ tự.
- FTP reply không có request ID; khi phát hiện trạng thái không an toàn hoặc cancel timeout, session bị đóng và client phải reconnect.
- LIST data socket reset sẽ retire session để không dùng lại control dialogue không chắc chắn.

Xem [tài liệu workspace](../README.md) và [tài liệu client](../client/README.md).
