import os
import secrets
import subprocess
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs


class AwsCliTransportTest(unittest.TestCase):
    def test_web_identity_scalar_is_read_from_stdin(self):
        control = secrets.token_urlsafe(24)
        received = []

        class Sts(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append(parse_qs(self.rfile.read(
                    int(self.headers["Content-Length"])).decode()))
                self.send_response(403)
                self.send_header("Content-Type", "text/xml")
                self.end_headers()
                self.wfile.write(b'<ErrorResponse><Error><Type>Sender</Type>'
                                 b'<Code>AccessDenied</Code><Message>Local test denial</Message>'
                                 b'</Error><RequestId>local</RequestId></ErrorResponse>')

            def log_message(self, *_args):
                pass

        # Exercise the real parser and serialization against a local STS stub;
        # no real credentials or AWS endpoint participate in this test.
        server = HTTPServer(("127.0.0.1", 0), Sts)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = subprocess.run(
                ["aws", "sts", "assume-role-with-web-identity",
                 "--role-arn", "arn:aws:iam::123456789012:role/parser-check",
                 "--role-session-name", "parser-check", "--duration-seconds", "900",
                 "--web-identity-token", "file:///dev/stdin",
                 "--region", "us-west-2", "--no-sign-request",
                 "--endpoint-url", f"http://127.0.0.1:{server.server_port}",
                 "--cli-connect-timeout", "1", "--cli-read-timeout", "1",
                 "--output", "json", "--no-cli-pager"],
                input=control, text=True, capture_output=True, timeout=30,
                env={**{name: value for name, value in os.environ.items()
                        if name in {"PATH", "HOME", "LANG", "TMPDIR", "SYSTEMROOT"}},
                     "AWS_CONFIG_FILE": os.devnull,
                     "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
                     "AWS_EC2_METADATA_DISABLED": "true"},
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertIn("(AccessDenied)", result.stderr.replace(control, "[generated control]"))
        self.assertEqual(len(received), 1, "The CLI never sent the parsed request")
        self.assertTrue(received[0].get("WebIdentityToken") == [control],
                        "The CLI did not forward the runtime token through stdin")
        self.assertEqual(received[0].get("Action"), ["AssumeRoleWithWebIdentity"])


if __name__ == "__main__":
    unittest.main()
