"""Local preview server: py serve.py  ->  http://localhost:8080
The iPhone camera needs HTTPS, so test on the phone via the GitHub Pages link."""
import http.server, socketserver

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", 8080), H) as s:
    print("Serving on http://localhost:8080")
    s.serve_forever()
