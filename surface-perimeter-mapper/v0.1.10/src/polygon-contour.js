// Decision-only contour follower. Coordinates and contact points are supplied
// by the adapter; this module never issues machine commands.
const vectors = [[1,0],[0,1],[-1,0],[0,-1]];
const dist = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
export function createPolygonContour({step, clearance, direction, maxMoves = 2000, restore = null}) {
    if (!(step > 0) || !(clearance > 0) || !Number.isInteger(direction) || direction < 1 || direction > 4)
        throw new Error('Invalid polygon search step, clearance or direction.');
    let heading = restore?.heading ?? [2,0,3,1][direction-1], phase = restore?.phase ?? 'initial', side=restore?.side, first=restore?.first?.slice(), closureContact=restore?.closureContact?.slice(), closureHeading=restore?.closureHeading, escaped = restore?.escaped ?? false, turns = restore?.turns ?? 0, moves = restore?.moves ?? 0;
    const contacts = (restore?.contacts ?? []).map(point=>point.slice()), seen = new Map(restore?.seen ?? []);
    let pending = restore?.pending ? {...restore.pending,origin:restore.pending.origin?.slice(),target:restore.pending.target?.slice()} : null, done = restore?.done ?? false;
    return {
        get contacts() { return contacts.map(p=>p.slice()); },
        snapshot() { return {heading,phase,side,first:first?.slice()??null,closureContact:closureContact?.slice()??null,closureHeading,escaped,turns,moves,contacts:contacts.map(p=>p.slice()),seen:[...seen],pending:pending?{...pending,origin:pending.origin?.slice(),target:pending.target?.slice()}:null,done}; },
        next(position, initialTarget) {
            if (done || pending) throw new Error('Polygon follower is not ready for another move.');
            if (!position?.every(Number.isFinite)) throw new Error('Polygon follower requires a valid stopped position.');
            if (++moves > maxMoves) {done=true;return {done:true,closed:false,reason:'move limit'};}
            if (phase === 'initial') {
                if (!initialTarget?.every(Number.isFinite)) throw new Error('Initial target is required.');
                pending={phase,origin:position.slice(),target:initialTarget.slice()}; return pending;
            }
            const anchor=closureContact||first,last=contacts[contacts.length-1],distance=dist(last,anchor);
            if(distance>step*4) escaped=true;
            if(escaped&&contacts.length>=12&&distance<=step*1.5&&closureHeading!==undefined&&(heading===closureHeading||Math.abs(turns)>=3)) {
                done=true;return {done:true,closed:true,reason:'closed near first contact'};
            }
            const key=[phase,Math.round(position[0]/(step*.3)),Math.round(position[1]/(step*.3)),heading].join(':');
            const previous=seen.get(key);
            if(previous!==undefined&&moves-previous>=4){done=true;return {done:true,closed:false,reason:'repeated state before closure'};}
            if(previous===undefined)seen.set(key,moves);
            const moveHeading=phase==='side'?(heading+(side===1?1:3))%4:heading;
            const vector=vectors[moveHeading], distanceToMove=phase==='side'?step+clearance:step;
            pending={phase,origin:position.slice(),target:[position[0]+vector[0]*distanceToMove,position[1]+vector[1]*distanceToMove],moveHeading};return pending;
        },
        observe({contact, stopped}) {
            if (!pending || !stopped?.every(Number.isFinite)) throw new Error('Unexpected polygon probe result.');
            const move=pending;pending=null;
            if(contact && !contact.every(Number.isFinite))throw new Error('Invalid polygon contact.');
            if(contact)contacts.push(contact.slice());
            if(move.phase==='initial') {
                if(!contact){done=true;return {done:true,closed:false,reason:'initial approach missed'};}
                first=contact.slice();let v=vectors[heading],a=[first[0]-move.origin[0],first[1]-move.origin[1]];
                const length=Math.hypot(...a);if(length<1e-6)throw new Error('Initial approach has no measurable direction.');
                let cross=v[0]*a[1]-v[1]*a[0];
                if(Math.abs(cross)<1e-6){heading=(heading+3)%4;v=vectors[heading];cross=v[0]*a[1]-v[1]*a[0];}
                side=cross>0?1:-1;
                if(Math.abs((v[0]*a[0]+v[1]*a[1])/length)>.85){
                    const normal=Math.abs(a[0])>=Math.abs(a[1])?[Math.sign(a[0]),0]:[0,Math.sign(a[1])];
                    heading=vectors.findIndex(t=>side*(-t[1]*normal[0]+t[0]*normal[1])>0);
                }
                phase='side';return {done:false};
            }
            if(move.phase==='side') {
                if(contact)phase='forward';else {heading=move.moveHeading;if(closureHeading!==undefined)turns+=side;}
            } else if(contact) {
                heading=(heading+(side===1?3:1))%4;if(closureHeading!==undefined)turns-=side;phase='side';
            } else {
                if(closureHeading===undefined){closureHeading=heading;closureContact=contacts[contacts.length-1].slice();turns=0;escaped=false;}
                phase='side';
            }
            return {done:false};
        }
    };
}
