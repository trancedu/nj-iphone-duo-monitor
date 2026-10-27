import subprocess
import unittest
from unittest.mock import patch
import monitor as m
from dataimpulse_curl import CurlDataImpulseClient


class CurlTests(unittest.TestCase):
    def client(self):return CurlDataImpulseClient({'DATAIMPULSE_PROXY_USERNAME':'dummy','DATAIMPULSE_PROXY_PASSWORD':'dummy-secret',
        'DATAIMPULSE_PROXY_HOST':'gw.dataimpulse.com','DATAIMPULSE_PROXY_PORT':'823'},'us',2)
    def test_deadline_and_authentication_are_only_in_stdin_not_process_args(self):
        result=subprocess.CompletedProcess([],0,b'HTTP/2 200\r\ncontent-type: application/json\r\n\r\n{}\n__PICKUP_CURL_META__200 2\n',b'')
        client=self.client()
        with patch('dataimpulse_curl.subprocess.run',return_value=result) as run:
            self.assertEqual(client.get('https://www.apple.com/'),'{}')
        args,kwargs=run.call_args
        self.assertNotIn('dummy-secret',str(args));self.assertIn(b'max-time = "2"',kwargs['input'])
        self.assertEqual(kwargs['timeout'],3);self.assertEqual(client.response_bytes,2)
    def test_server_retry_after_preserved_even_if_curl_failed(self):
        result=subprocess.CompletedProcess([],22,b'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\n\r\n\n__PICKUP_CURL_META__429 0\n',b'PRIVATE ERROR')
        with patch('dataimpulse_curl.subprocess.run',return_value=result):
            with self.assertRaises(m.QueryError) as error:self.client().get('https://www.apple.com/')
        self.assertEqual(error.exception.code,'http_429');self.assertEqual(error.exception.retry_after,120)
    def test_partial_timeout_is_not_a_valid_inventory_refresh(self):
        result=subprocess.CompletedProcess([],28,b'HTTP/2 200\r\n\r\n{partial\n__PICKUP_CURL_META__200 8\n',b'PRIVATE ERROR')
        with patch('dataimpulse_curl.subprocess.run',return_value=result):
            with self.assertRaises(m.QueryError) as error:self.client().get('https://www.apple.com/')
        self.assertEqual(error.exception.code,'network_error')
