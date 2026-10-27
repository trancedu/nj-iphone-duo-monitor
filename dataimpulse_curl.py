"""Total-deadline proxy transport; authentication is passed on stdin, never argv."""
import datetime as dt
import email.utils
import subprocess
import urllib.parse
import urllib.request
import monitor as m
from dataimpulse_client import DataImpulseClient


class CurlDataImpulseClient(DataImpulseClient):
    def __init__(self,environ,country='us',total_timeout=2):
        super().__init__(environ,country);self.total_timeout=total_timeout
    def clone(self):return CurlDataImpulseClient(self._settings,self.country,self.total_timeout)
    def get(self,url):
        proxy=next(h for h in self.opener.handlers if isinstance(h,urllib.request.ProxyHandler)).proxies['https']
        parts=urllib.parse.urlsplit(proxy)
        def quoted(value):
            return '"'+str(value).replace('\\','\\\\').replace('"','\\"').replace('\n','\\n').replace('\r','\\r')+'"'
        settings={'url':url,'proxy':'http://'+parts.hostname+':'+str(parts.port),
            'proxy-user':urllib.parse.unquote(parts.username)+':'+urllib.parse.unquote(parts.password),
            'max-time':self.total_timeout,'connect-timeout':self.total_timeout,'max-filesize':1048576,
            'user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'}
        config='\n'.join(k+' = '+quoted(v) for k,v in settings.items())+'\n'
        result=subprocess.run(['/usr/bin/curl','--config','-','--silent','--show-error','--noproxy','',
            '--include','--suppress-connect-headers','--write-out','\n__PICKUP_CURL_META__%{http_code} %{size_download}\n'],
            input=config.encode(),capture_output=True,timeout=self.total_timeout+1)
        try:
            response,meta=result.stdout.rsplit(b'\n__PICKUP_CURL_META__',1)
            status,size=meta.decode('ascii').strip().split();status=int(status);self.response_bytes+=int(size)
        except (ValueError,UnicodeError):raise m.QueryError('network_error') from None
        headers={}
        while response.startswith(b'HTTP/'):
            try:head,response=response.split(b'\r\n\r\n',1)
            except ValueError:raise m.QueryError('network_error') from None
            headers={}
            for line in head.split(b'\r\n')[1:]:
                if b':' in line:
                    key,value=line.split(b':',1);headers[key.decode('ascii','ignore').lower()]=value.decode('latin1').strip()
        if status>=400:
            retry=headers.get('retry-after','');seconds=int(retry) if retry.isdigit() else 0
            if retry and not seconds:
                try:seconds=max(0,int(email.utils.parsedate_to_datetime(retry).timestamp()-dt.datetime.now(dt.timezone.utc).timestamp()))
                except (ValueError,TypeError):pass
            raise m.QueryError('http_'+str(status),seconds)
        if result.returncode or status!=200:raise m.QueryError('network_error')
        try:return response.decode('utf-8')
        except UnicodeError:raise m.QueryError('non_json_response') from None
