// Standard GRBL reports end the complete axis list with :1 (transition) or :0 (miss).
export function formatProbeReport(position,triggered){
    if(!Array.isArray(position)||position.length<3||!position.every(Number.isFinite))throw Error('Probe report needs at least three finite machine coordinates.');
    return `[PRB:${position.map(v=>v.toFixed(3)).join(',')}:${triggered?'1':'0'}]`;
}
export function formatProbePins(active){return active?'|Pn:P':'';}
