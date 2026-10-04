// Arrivals are acknowledged by the reader, not by automatically displaying them.
// Deliberately browsing history does not opt back into following the latest.
export function createBriefArrivalTracker() {
  let currentGoalId=null,baseline=0,pending=false;
  const observe=(goalId,version,latestVersion)=>{
    if(goalId!==currentGoalId){currentGoalId=goalId;baseline=latestVersion;pending=false;}
    if(!goalId){baseline=0;pending=false;return false;}
    if(latestVersion>baseline){
      if(version===baseline)pending=true;
      baseline=latestVersion;
    }
    return pending;
  };
  observe.dismiss=()=>{pending=false;};
  return observe;
}
