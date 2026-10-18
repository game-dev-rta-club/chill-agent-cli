// Whether a chat is quiet enough to be asked to continue, from the facts its agent observed.
export function continuationEligibility(f){
 if(f.paused)return 'paused';
 if(f.pendingFeedback.length)return 'feedback-pending';
 if(f.queue.length)return 'queued';
 if(!f.stable||!['idle','notLoaded','active'].includes(f.harnessState))return 'unknown';
 if(f.harnessState==='active'||f.heartbeatFresh||f.turn&&f.turn.completedAt==null)return 'running';
 if(!f.turn||!Number.isFinite(f.turn.completedAt)||!['completed','failed'].includes(f.turn.status))return 'unknown';
 return 'idle';
}
