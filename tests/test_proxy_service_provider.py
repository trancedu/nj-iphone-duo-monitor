"""Manual provider selection must preserve a strict no-paid-fallback Clash mode."""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('proxy_service',Path(__file__).resolve().parents[1]/'deploy/proxy_service.py')
service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)

class ProviderTests(unittest.TestCase):
    def run_install(self, env_provider, explicit):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);runtime=root/'runtime/proxy-monitor';runtime.mkdir(parents=True)
            (runtime/'live-provider.json').write_text('{"provider":"dataimpulse"}')
            config=root/'clash.yaml';config.write_text('proxies: []')
            binary=root/'mihomo';binary.write_text('stub');binary.chmod(0o700)
            argv=['proxy_service.py','start-live','--clash-config',str(config),'--mihomo',str(binary)]
            if explicit:argv+=['--provider',explicit]
            with patch.object(service,'ROOT',root),patch.object(service.Path,'home',return_value=root), \
                 patch.object(service.sys,'argv',argv),patch.dict(os.environ,{'IPHONE_MONITOR_PROVIDER':env_provider}), \
                 patch.object(service.subprocess,'run',return_value=subprocess.CompletedProcess([],0)):
                service.main()
            job=plistlib.loads((root/'Library/LaunchAgents/com.trancedu.iphone-duo-proxy-live.plist').read_bytes())
            self.assertIn('proxy_monitor.py',' '.join(job['ProgramArguments']))
            self.assertIn('--disable-paid-fallback',job['ProgramArguments'])
            self.assertEqual(job['EnvironmentVariables'],{'IPHONE_MONITOR_PROVIDER':'clash'})
            self.assertEqual(json.loads((runtime/'live-provider.json').read_text()),{'provider':'clash'})
    def test_environment_overrides_saved_paid_provider(self):self.run_install('clash',None)
    def test_explicit_selection_overrides_environment(self):self.run_install('dataimpulse','clash')

if __name__=='__main__':unittest.main()
