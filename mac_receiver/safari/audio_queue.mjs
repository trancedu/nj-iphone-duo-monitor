import {randomUUID} from 'node:crypto';
// One queue per resident process: playback runs in afplay/say child processes.
export class AudioQueue {
  constructor({play,maxPending=32,onSubmit=()=>{},onComplete=()=>{}}){this.play=play;this.maxPending=maxPending;this.onSubmit=onSubmit;this.onComplete=onComplete;this.jobs=[];this.running=false;this.waiters=[];}
  submit(plan,context={}){
    if(this.jobs.length>=this.maxPending)return {audio_queued:false,audio_reason:'audio_queue_full'};
    const job={id:randomUUID(),plan,context,queued_at:new Date().toISOString()};this.jobs.push(job);
    try{this.onSubmit(job);}catch{}
    if(!this.running){this.running=true;setImmediate(()=>this.drain());}
    return {audio_queued:true,audio_job_id:job.id};
  }
  async drain(){
    while(this.jobs.length){
      const job=this.jobs.shift();job.started_at=new Date().toISOString();let result;
      try{result=await this.play(job.plan);}catch{result={sound_played:false,speech_spoken:false,audio_reason:'audio_playback_failed'};}
      try{this.onComplete({...job,finished_at:new Date().toISOString()},result);}catch{}
    }
    this.running=false;for(const resolve of this.waiters.splice(0))resolve();
  }
  get state(){return {busy:this.running,pending_jobs:this.jobs.length};}
  idle(){return this.running?new Promise(resolve=>this.waiters.push(resolve)):Promise.resolve();}
}
