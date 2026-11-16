// Duration at 1×, excluding acceleration and controller/planner delays.
export function motionDurationMs(from, to, rapid, feed, rapidRates) {
  const delta=from.map((v,i)=>Math.abs(to[i]-v));
  if(rapid){
    return Math.max(...delta.map((d,i)=>d/rapidRates[i]))*60000;
  }
  return Math.hypot(...delta)/feed*60000;
}

export function advanceMotion(elapsedSimulationMs, realDeltaMs, multiplier, durationMs) {
  return durationMs<=0?1:Math.min(1,(elapsedSimulationMs+Math.max(0,realDeltaMs)*multiplier)/durationMs);
}
