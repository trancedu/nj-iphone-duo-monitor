"""Credential-safe DataImpulse transport shared by bounded tests and fallback."""
import re
import http.client
import urllib.parse
import urllib.request
import monitor as m
from pickup_bridge import NoRedirect


class DataImpulseClient(m.Client):
    def __init__(self, environ, country=None):
        super().__init__()
        self._settings = {key: environ.get(key, '') for key in
            ('DATAIMPULSE_PROXY_USERNAME','DATAIMPULSE_PROXY_PASSWORD','DATAIMPULSE_PROXY_HOST','DATAIMPULSE_PROXY_PORT')}
        values = {key: environ.get('DATAIMPULSE_PROXY_'+key, '').strip() for key in ('USERNAME', 'PASSWORD', 'HOST', 'PORT')}
        if not all(values.values()): raise ValueError('missing_proxy_configuration')
        host = values['HOST'].lower()
        if not re.fullmatch(r'[a-z0-9.-]+', host) or not host.endswith('.dataimpulse.com'):
            raise ValueError('invalid_proxy_host')
        if not values['PORT'].isdigit() or not 1 <= int(values['PORT']) <= 65535:
            raise ValueError('invalid_proxy_port')
        self.country = country
        if country:
            if not re.fullmatch(r'[a-z]{2}', country): raise ValueError('invalid_country')
            login, _, options = values['USERNAME'].partition('__')
            parameters = [v for v in options.split(';') if v and not v.startswith('cr.')]
            values['USERNAME'] = login+'__'+';'.join(['cr.'+country, *parameters])
        url = 'http://'+urllib.parse.quote(values['USERNAME'], safe='')+':'+urllib.parse.quote(values['PASSWORD'], safe='')+'@'+host+':'+values['PORT']
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({'http': url, 'https': url}), NoRedirect())
        self.opener.addheaders = m.Client().opener.addheaders
        self.response_bytes = 0

    def clone(self):
        """Independent opener/counters for a second bounded hedge connection."""
        return DataImpulseClient(self._settings, self.country)

    def read(self, url):
        with self.opener.open(url, timeout=12) as response:
            data = response.read(262144)
            self.response_bytes += len(data)
            return data.decode('utf-8')

    def get(self, url):
        # Inventory errors are reduced to safe codes by Client.get, preserving
        # its existing status/error parsing while imposing a shorter timeout.
        opener = self.opener
        class WithTimeout:
            def open(inner, request, timeout=25): return opener.open(request, timeout=12)
        self.opener = WithTimeout()
        try:
            body = super().get(url)
            self.response_bytes += len(body.encode())
            return body
        except http.client.IncompleteRead as error:
            self.response_bytes += len(error.partial)
            raise m.QueryError('network_error') from None
        except http.client.HTTPException:
            raise m.QueryError('network_error') from None
        finally:
            self.opener = opener

