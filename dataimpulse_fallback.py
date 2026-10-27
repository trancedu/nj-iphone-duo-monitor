"""Bounded freshness-triggered hedging; never configures the primary proxy pool."""
import datetime as dt
import json
import math
import os
from pathlib import Path
import time
from dataimpulse_client import DataImpulseClient


def load_settings(path):
    cfg=json.loads(Path(path).read_text())
    if not isinstance(cfg.get('run_id'),str) or not cfg['run_id'] or len(cfg['run_id'])>100:raise ValueError('invalid_fallback_id')
    if not isinstance(cfg.get('enabled_until_epoch'),(int,float)) or not math.isfinite(cfg['enabled_until_epoch']):raise ValueError('invalid_fallback_expiry')
    if not 1<=cfg.get('stale_after_seconds',2)<=4:raise ValueError('invalid_fallback_staleness')
    if not 0<=cfg.get('max_per_minute',12)<=30:raise ValueError('invalid_fallback_rate')
    if not 1<=cfg.get('max_requests',120)<=300:raise ValueError('invalid_fallback_requests')
    if not 1<=cfg.get('max_body_mib',20)<=50:raise ValueError('invalid_fallback_body_budget')
    if not .2<=cfg.get('min_start_spacing_seconds',.2)<=2:raise ValueError('invalid_fallback_spacing')
    if cfg.get('max_in_flight',1) not in (1,2):raise ValueError('invalid_fallback_parallelism')
    if not 2<=cfg.get('parallel_after_seconds',2.5)<=4:raise ValueError('invalid_second_hedge_threshold')
    if cfg.get('transport','urllib') not in ('urllib','curl'):raise ValueError('invalid_fallback_transport')
    if not 1<=cfg.get('total_timeout_seconds',2)<=5:raise ValueError('invalid_fallback_deadline')
    if cfg['enabled_until_epoch']>time.time()+1800:raise ValueError('fallback_trial_max_30_minutes')
    env={}
    env_file=Path(cfg['env_file'])
    if env_file.stat().st_mode & 0o077:raise ValueError('fallback_env_requires_600')
    for line in env_file.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key,value=line.split('=',1);env[key.strip()]=value.strip().strip('\"\'')
    if cfg.get('transport')=='curl':
        from dataimpulse_curl import CurlDataImpulseClient
        return cfg,CurlDataImpulseClient(env,'us',cfg.get('total_timeout_seconds',2))
    return cfg,DataImpulseClient(env,'us')


class FreshnessHedge:
    def __init__(self,settings,state,now):
        self.cfg=settings;self.state=state;self.last_success=now
        if state.get('run_id')!=settings['run_id']:
            state.clear();state.update(run_id=settings['run_id'],starts=[],requests=0,body_bytes=0,failures=0,retry_at=0)

    def reason_not_ready(self,now,in_flight=False,global_blocked_until=0,oldest_pending_age=None):
        self.state['starts']=[s for s in self.state['starts'] if now-60<s]
        if now>=self.cfg['enabled_until_epoch']:return 'expired'
        if self.state['requests']>=self.cfg.get('max_requests',120):return 'request_budget'
        if self.state['body_bytes']>=self.cfg.get('max_body_mib',20)*1024*1024:return 'body_budget'
        if int(in_flight)>=self.cfg.get('max_in_flight',1):return 'in_flight'
        if in_flight and (now-self.last_success<self.cfg.get('parallel_after_seconds',2.5) or
                          oldest_pending_age is None or oldest_pending_age<1):return 'second_hedge_not_due'
        if now<max(global_blocked_until,self.state.get('retry_at',0)):return 'backoff'
        if len(self.state['starts'])>=self.cfg.get('max_per_minute',12):return 'rate_budget'
        if self.state['starts'] and now-self.state['starts'][-1]<self.cfg.get('min_start_spacing_seconds',.2):return 'minimum_spacing'
        if now-self.last_success<self.cfg.get('stale_after_seconds',2):return 'fresh'
        return None

    def dispatched(self,now):
        self.state['starts'].append(now);self.state['requests']+=1

    def success(self,now):self.last_success=now

    def finished(self,now,success,body_bytes=0,retry_after=0):
        self.state['body_bytes']+=body_bytes
        if success:
            self.last_success=now;self.state['failures']=0;self.state['retry_at']=0
        else:
            self.state['failures']+=1
            # Two quick alternate-connection attempts, then exponential backoff.
            delay=max(retry_after,.2 if self.state['failures']<=2 else min(60,2**min(self.state['failures']-2,6)))
            self.state['retry_at']=now+delay
