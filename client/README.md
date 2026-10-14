# MODULE CLIENT — ELECTRON FTP CLIENT

Client là ứng dụng desktop Electron + React. Giao diện người dùng được giữ nguyên từ source ban đầu; toàn bộ giao tiếp với backend và filesystem cục bộ được đặt sau preload bridge và IPC.

---

## 🎯 MỤC TIÊU

Client chịu trách nhiệm:

- Hiển thị danh sách tệp cục bộ và tệp trên FTP server.
- Gửi yêu cầu quản lý FTP tới NestJS API qua HTTP.
- Upload/download tệp theo dạng stream, không nạp toàn bộ file vào RAM.
- Nhận tiến độ truyền file qua WebSocket chuẩn.
- Thao tác tệp cục bộ trong Electron main process.
- Cô lập renderer khỏi Node.js và filesystem bằng preload bridge.

Client **không import source code của server** và không tự mở FTP socket.

---

## ⚙️ CÔNG NGHỆ SỬ DỤNG

| Thành phần | Công nghệ |
| --- | --- |
| Ngôn ngữ | TypeScript |
| Desktop runtime | Electron |
| Giao diện | React |
| Build tool | electron-vite, Vite |
| Giao tiếp API | Fetch API, HTTP streaming |
| Realtime | WebSocket chuẩn |
| Validation response | Zod |
| Kiểm thử | Node.js test runner |

Preload cung cấp ba API cho renderer:

- `window.ftp`: session, remote file và transfer operations.
- `window.local`: thao tác filesystem cục bộ.
- `window.desktop`: thông tin platform và phiên bản bridge.

---

## 🔧 CẤU HÌNH

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `FTP_API_BASE_URL` | `http://127.0.0.1:3000/api` | Base URL REST API; bắt buộc giữ hậu tố `/api` |
| `FTP_WS_BASE_URL` | Tự suy ra từ API URL | Base `ws://` hoặc `wss://`; client tự nối `/transfers` |
| `ELECTRON_RENDERER_URL` | Do electron-vite cấp | URL trang renderer khi chạy development |

`FTP_API_BASE_URL` được Electron main đọc từ `process.env` lúc khởi động. Sau khi thay đổi phải khởi động lại client. URL chỉ chấp nhận HTTP/HTTPS, không cho phép credential, query hoặc fragment.

`VITE_API_BASE_URL` **không được sử dụng**; renderer không gọi backend trực tiếp. File `.env.example` là tài liệu tham khảo, còn biến thực tế cần được đặt trong môi trường tiến trình chạy Electron.

### Client và backend ở hai máy khác nhau

Ví dụ backend chạy trên máy A có IP `192.168.1.10`:

```powershell
$env:FTP_API_BASE_URL = 'http://192.168.1.10:3000/api'
$env:FTP_WS_BASE_URL = 'ws://192.168.1.10:3000'
pnpm --dir source/client dev
```

Máy A phải cho phép cổng `3000` qua firewall. Nếu không đặt `FTP_WS_BASE_URL`, client tự chuyển `http` thành `ws` hoặc `https` thành `wss`.

---

## 🚀 HƯỚNG DẪN CHẠY

Từ thư mục gốc repository, cài dependency một lần:

```powershell
pnpm --dir source install
```

Khởi động backend ở terminal thứ nhất, sau đó chạy client ở terminal thứ hai:

```powershell
$env:FTP_API_BASE_URL = 'http://127.0.0.1:3000/api'
pnpm --dir source/client dev
```

Các lệnh module:

```powershell
pnpm --dir source/client dev
pnpm --dir source/client test
pnpm --dir source/client lint
pnpm --dir source/client build
pnpm --dir source/client preview
```

| Lệnh | Chức năng |
| --- | --- |
| `dev` | Chạy Electron ở chế độ development |
| `test` | Chạy client test bằng Node.js 24+ |
| `lint` | Kiểm tra type bằng `tsc --noEmit` |
| `build` | Build main, preload và renderer vào `out/` |
| `preview` | Chạy Electron từ output đã build |

Project chưa cấu hình electron-builder/electron-forge nên `build` tạo application bundle, **không tạo file installer**.

---

## 📁 FILE CỤC BỘ VÀ TRUYỀN DỮ LIỆU

- Local pane bắt đầu tại thư mục Downloads của người dùng.
- Liệt kê, đổi thư mục, tạo, đổi tên, di chuyển và xóa file local chạy trong Electron main qua IPC.
- Tên file Windows nguy hiểm, drive-relative, ADS, traversal và device name bị từ chối tại main-process boundary.
- Upload đọc file local thành stream và gửi `application/octet-stream` cùng `Content-Length`, `x-transfer-id`, `x-remote-path-encoded`.
- Download ghi vào file tạm `.ftp-client-part-*` cùng thư mục đích, chỉ publish atomically sau khi HTTP hoàn thành.
- Khi lỗi/hủy, client xóa đúng file tạm do chính transfer tạo và không ghi đè file đích.
- Disconnect hoặc thoát ứng dụng sẽ dọn transfer và đóng WebSocket trong thời gian giới hạn.

WebSocket tự reconnect tối đa năm lần khi mất kết nối ngoài ý muốn, nhưng dừng khi server đóng với policy code `1008` hoặc session không còn hợp lệ.

---

## 📦 CẤU TRÚC MODULE

```text
client/
├── README.md
├── .env.example
├── package.json
├── electron.vite.config.ts
├── src/
│   ├── renderer/              # React UI
│   ├── preload/               # Context bridge
│   ├── main/                  # REST, WebSocket, IPC, shutdown
│   ├── local/                 # Filesystem cục bộ
│   ├── schemas/               # Zod response schemas
│   └── shared/                # API types/channels
└── test/                      # Client tests
```

---

## 💡 SỬ DỤNG

1. Khởi động NestJS server.
2. Mở client và nhập địa chỉ FTP, ví dụ `ftp://127.0.0.1:2121`.
3. Đăng nhập bằng tài khoản của FTP server.
4. Quản lý file local/remote hoặc kéo thả để upload/download.
5. Theo dõi tiến độ ở transfer panel; có thể hủy transfer đang chạy.
6. Disconnect trước khi đóng nếu muốn kết thúc session ngay.

---

## 🧪 KIỂM THỬ

```powershell
pnpm --dir source/client test
```

Bộ test kiểm tra API URL, envelope validation, IPC, session lifecycle, upload/download streaming, cancel settlement, partial-file cleanup, Windows path safety, WebSocket và shutdown.

---

## 📝 GHI CHÚ

- Backend phải chạy trước khi thao tác FTP.
- Mỗi cửa sổ client giữ session riêng; nhiều máy có thể truyền đồng thời.
- Trong một FTP session chỉ có một data transfer hoạt động tại một thời điểm.
- Khi không xác nhận được cancel settlement, client bỏ session và yêu cầu kết nối lại để tránh lẫn FTP reply.

Xem [tài liệu workspace](../README.md) và [tài liệu server](../server/README.md).
