const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

function offsetOpenPoints(input,delta){
  const points=input.filter((point,index)=>!index||distance(point,input[index-1])>1e-6);
  if(points.length<2)return[];
  const normals=[];
  for(let i=1;i<points.length;i++){
    const dx=points[i].x-points[i-1].x,dy=points[i].y-points[i-1].y,len=Math.hypot(dx,dy);
    if(len<1e-9)continue;
    normals.push({x:-dy/len,y:dx/len});
  }
  if(normals.length!==points.length-1)return[];
  const result=[{x:points[0].x+normals[0].x*delta,y:points[0].y+normals[0].y*delta}];
  for(let i=1;i<points.length-1;i++){
    const a=normals[i-1],b=normals[i],sum={x:a.x+b.x,y:a.y+b.y},length=Math.hypot(sum.x,sum.y);
    if(length<1e-8){result.push({x:points[i].x+a.x*delta,y:points[i].y+a.y*delta},{x:points[i].x+b.x*delta,y:points[i].y+b.y*delta});continue}
    const unit={x:sum.x/length,y:sum.y/length},denom=unit.x*b.x+unit.y*b.y,miter=denom?delta/denom:Infinity;
    if(Math.abs(miter)>Math.max(Math.abs(delta)*4,.01))result.push({x:points[i].x+a.x*delta,y:points[i].y+a.y*delta},{x:points[i].x+b.x*delta,y:points[i].y+b.y*delta});
    else result.push({x:points[i].x+unit.x*miter,y:points[i].y+unit.y*miter});
  }
  const end=points.at(-1),normal=normals.at(-1);
  result.push({x:end.x+normal.x*delta,y:end.y+normal.y*delta});
  return result;
}

function optimizePathOrder(paths,start={x:0,y:0}){
  const remaining=paths.map(path=>[...path]),ordered=[];
  let current=start;
  while(remaining.length){
    let best=null;
    for(let i=0;i<remaining.length;i++){
      const path=remaining[i],forward=distance(current,path[0]),reverse=distance(current,path.at(-1)),cost=Math.min(forward,reverse);
      if(!best||cost<best.cost)best={i,cost,reverse:reverse<forward};
    }
    const path=remaining.splice(best.i,1)[0],chosen=best.reverse?path.reverse():path;
    ordered.push(chosen);current=chosen.at(-1);
  }
  return ordered;
}

export function buildSlotToolpath({centerlines,diameter,width,stepover,depth,stepdown,safeZ,feed,plunge,rpm}){
  if(!Array.isArray(centerlines)||!centerlines.length)throw new Error('Select one or more visible open vectors to use as slot centerlines.');
  const values=[diameter,width,stepover,depth,stepdown,safeZ,feed,plunge,rpm];
  if(!values.every(Number.isFinite)||values.some(value=>value<=0))throw new Error('Enter positive slot, depth, pass, clearance and cutting values.');
  if(width<diameter-1e-6)throw new Error('Slot width must be at least as wide as the selected cutter.');
  if(stepover>diameter)throw new Error('Slot pass stepover cannot exceed the cutter diameter.');
  const extra=Math.max(0,width-diameter),sidePasses=extra<.01?1:Math.ceil(extra/stepover)+1;
  if(sidePasses>250)throw new Error('Slot width requires more than 250 parallel passes. Increase stepover or reduce width.');
  const offsets=sidePasses===1?[0]:Array.from({length:sidePasses},(_,index)=>-extra/2+extra*index/(sidePasses-1));
  const paths=centerlines.flatMap(points=>offsets.map(offset=>offsetOpenPoints(points,offset)).filter(path=>path.length>=2));
  if(!paths.length)throw new Error('Could not create slot passes from the selected vectors.');
  const depthPasses=[];
  for(let current=Math.min(stepdown,depth);;current=Math.min(depth,current+stepdown)){depthPasses.push(current);if(current>=depth-1e-9)break}
  const lines=['(Carve Studio slot)','(Selected open vectors are slot centerlines; cutter paths are offset to cover the entered slot width.)','(Cutter diameter '+diameter.toFixed(3)+' mm; slot width '+width.toFixed(3)+' mm; '+sidePasses+' parallel pass'+(sidePasses===1?'':'es')+' per centerline.)','(Depth '+depth.toFixed(3)+' mm in '+depthPasses.length+' depth pass'+(depthPasses.length===1?'':'es')+'.)','G21 G90 G17 G94','G0 Z'+safeZ.toFixed(3),'M3 S'+Math.round(rpm)];
  let current={x:0,y:0};
  for(const passDepth of depthPasses){
    const ordered=optimizePathOrder(paths,current);
    for(const path of ordered){
      const start=path[0],end=path.at(-1);
      lines.push('(Slot depth '+passDepth.toFixed(3)+' mm)','G0 Z'+safeZ.toFixed(3),'G0 X'+start.x.toFixed(3)+' Y'+start.y.toFixed(3),'G1 Z-'+passDepth.toFixed(3)+' F'+plunge.toFixed(1));
      for(const point of path.slice(1))lines.push('G1 X'+point.x.toFixed(3)+' Y'+point.y.toFixed(3)+' F'+feed.toFixed(1));
      lines.push('G0 Z'+safeZ.toFixed(3));current=end;
    }
  }
  lines.push('M5','M30');
  return{gcode:lines.join('\n')+'\n',paths,sidePasses,depthPasses:depthPasses.length};
}
