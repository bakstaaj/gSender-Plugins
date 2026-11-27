// Normalize SVG shorthand and relative coordinates without flattening its curves.
const number = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/y;

export function parseNodePath(data) {
  let index=0, command='', position=[0,0], contour;
  const contours=[];
  const skip=()=>{while (index<data.length && /[\s,]/.test(data[index])) index++};
  function read(flag=false) {
    skip();
    number.lastIndex=index;
    const match=flag ? /^[01]/.exec(data.slice(index,index+1)) : number.exec(data);
    if (!match) throw Error('Could not read the SVG path.');
    index+=match[0].length;
    const value=Number(match[0]);
    if (!Number.isFinite(value)) throw Error('The SVG path contains invalid coordinates.');
    return value;
  }
  while (index<data.length) {
    skip();
    if (index===data.length) break;
    if (/[A-Za-z]/.test(data[index])) command=data[index++];
    const type=command.toUpperCase(), relative=command!==type;
    const pair=()=>{
      const x=read(),y=read();
      return relative?[position[0]+x,position[1]+y]:[x,y];
    };
    if (type==='M') {
      position=pair();
      contour={closed:false,nodes:[{type:'M',point:position}]};
      contours.push(contour);
      command=relative?'l':'L';
      continue;
    }
    if (!contour) throw Error('The SVG path has no start point.');
    if (type==='Z') {
      contour.closed=true;
      position=contour.nodes[0].point;
      command='';
      continue;
    }
    if (contour.closed) {
      contour={closed:false,nodes:[{type:'M',point:position}]};
      contours.push(contour);
    }
    const previous=contour.nodes.at(-1);
    let next;
    if (type==='L') next={type:'L',point:pair()};
    else if (type==='H' || type==='V') {
      const axis=type==='H'?0:1;
      const point=[...position];
      point[axis]=read()+(relative?position[axis]:0);
      next={type:'L',point};
    } else if ('QCST'.includes(type) && type) {
      const normalized='QT'.includes(type)?'Q':'C';
      const prior=previous.type===normalized?previous.controls.at(-1):position;
      const first='ST'.includes(type)?[2*position[0]-prior[0],2*position[1]-prior[1]]:pair();
      const controls=normalized==='Q'?[first]:[first,pair()];
      next={type:normalized,controls,point:pair()};
    } else if (type==='A') {
      const arc=[read(),read(),read(),read(true),read(true)];
      next={type:'A',arc,point:pair()};
    } else {
      throw Error('Could not read the SVG path.');
    }
    position=next.point;
    contour.nodes.push(next);
  }
  // Glyph outlines can include line commands that repeat the preceding point.
  for (const contour of contours) {
    contour.nodes=contour.nodes.filter((node,i,nodes)=>node.type!=='L'||!samePoint(node.point,nodes[i-1].point));
  }
  return contours.filter(contour=>contour.nodes.length>1);
}

function writePath(contours) {
  return contours.map(({nodes,closed})=>nodes.map(node=>
    node.type+[...(node.arc||[]),...(node.controls||[]).flat(),...node.point].join(' ')).join(' ')+
    (closed?' Z':'')).join(' ');
}

const distance = ([ax,ay],[bx,by])=>Math.hypot(ax-bx,ay-by);
const mix = ([ax,ay],[bx,by],t)=>[ax+(bx-ax)*t,ay+(by-ay)*t];
const samePoint = (a,b)=>distance(a,b)<1e-7;
const isEllipse = object=>object.kind==='circle'||object.kind==='ellipse';

export function createNodeModel(object,stockHeight) {
  if (isEllipse(object)) return {object:{...object},contours:[]};
  if (object.kind==='path') {
    if (typeof object.d!=='string') throw Error('This SVG path has no geometry.');
    return {object,stockHeight,contours:parseNodePath(object.d)};
  }
  let points=[], closed=object.kind==='polygon'||object.kind==='rect';
  if (object.kind==='line') points=[[object.x1,object.y1],[object.x2,object.y2]];
  else if (object.kind==='rect') points=[[object.x1,object.y1],[object.x2,object.y1],[object.x2,object.y2],[object.x1,object.y2]];
  else if (object.points) points=object.points.map(point=>[...point]);
  points=points.filter((point,i,all)=>!i||!samePoint(point,all[i-1]));
  if (points.length>2 && samePoint(points[0],points.at(-1))) {
    points.pop();
    closed=true;
  }
  const nodes=points.map((point,index)=>({type:index?'L':'M',point}));
  return {object,contours:nodes.length>1?[{nodes,closed}]:[]};
}

function world(model,[x,y]) {
  const {object,stockHeight}=model;
  if (object.kind!=='path') return [x,y];
  return [x*(object.sx||1)+(object.dx||0)+(object.ox||0),
    stockHeight-y*(object.sy||1)-(object.dy||0)-(object.oy||0)];
}

function local(model,[x,y]) {
  const {object,stockHeight}=model;
  if (object.kind!=='path') return [x,y];
  return [(x-(object.dx||0)-(object.ox||0))/(object.sx||1),
    (stockHeight-y-(object.dy||0)-(object.oy||0))/(object.sy||1)];
}

const seam = ({closed,nodes})=>closed&&nodes.length>2&&samePoint(nodes[0].point,nodes.at(-1).point);

export function nodeHandles(model,selection) {
  const o=model.object;
  if (isEllipse(o)) {
    const handles=[{key:'center',kind:'center',point:[o.cx,o.cy]},
      {key:'radius-x',kind:'radius',point:[o.cx+(o.r??o.rx),o.cy],origin:[o.cx,o.cy]}];
    if(o.kind==='ellipse') handles.push({key:'radius-y',kind:'radius',point:[o.cx,o.cy+o.ry],origin:[o.cx,o.cy]});
    return handles;
  }
  const handles=[], selectedKey=selection?.anchor||selection?.key;
  model.contours.forEach((contour,path)=>{
    const {nodes}=contour, joined=seam(contour);
    const anchorKey=index=>path+':'+(joined&&index===nodes.length-1?0:index);
    nodes.forEach((node,index)=>{
      const key=anchorKey(index);
      if (!joined||index!==nodes.length-1) handles.push({key,kind:'node',path,index,point:world(model,node.point)});
      node.controls?.forEach((point,control)=>{
        const before=anchorKey(index-1), after=key;
        if (selectedKey!==before && selectedKey!==after) return;
        const incoming=node.controls.length>1?control===1:selectedKey===after;
        const owner=incoming?index:index-1;
        handles.push({key:path+':'+index+':'+control,kind:'control',path,index,control,
          anchor:anchorKey(owner),point:world(model,point),origin:world(model,nodes[owner].point)});
      });
    });
  });
  return handles;
}

export function updateNode(model,handle,worldPoint) {
  if (!worldPoint.every(Number.isFinite)) return;
  const o=model.object;
  if (isEllipse(o)) {
    const [x,y]=worldPoint;
    if(handle.key==='center') [o.cx,o.cy]=worldPoint;
    else if (o.kind==='circle') o.r=Math.max(.01,distance([o.cx,o.cy],worldPoint));
    else if (handle.key==='radius-x') o.rx=Math.max(.01,Math.abs(x-o.cx));
    else o.ry=Math.max(.01,Math.abs(y-o.cy));
    return;
  }
  const contour=model.contours[handle.path], nodes=contour.nodes;
  const node=nodes[handle.index], next=local(model,worldPoint);
  if (handle.kind==='control') {
    node.controls[handle.control]=next;
    return;
  }
  const [dx,dy]=[next[0]-node.point[0],next[1]-node.point[1]];
  const move=([x,y])=>[x+dx,y+dy];
  const joined=seam(contour) && handle.index===0;
  const incoming=joined?nodes.at(-1):node;
  if(incoming.controls) incoming.controls[incoming.controls.length-1]=move(incoming.controls.at(-1));
  const outgoing=nodes[handle.index+1];
  if(outgoing?.controls) outgoing.controls[0]=move(outgoing.controls[0]);
  if(joined) incoming.point=next;
  node.point=next;
}

export function canDeleteNode(model,handle) {
  if (handle?.kind!=='node') return false;
  const contour=model.contours[handle.path];
  const minimum=contour.closed?3:2;
  return contour.nodes.length-(seam(contour)?1:0)>minimum;
}

export function deleteNode(model,handle) {
  if (!canDeleteNode(model,handle)) return false;
  const contour=model.contours[handle.path];
  if (handle.index===0 && seam(contour)) contour.nodes.pop();
  contour.nodes.splice(handle.index,1);
  contour.nodes[0]={type:'M',point:contour.nodes[0].point};
  return true;
}

function split(points,t) {
  const left=[points[0]], right=[points.at(-1)];
  while (points.length>1) {
    points=points.slice(1).map((point,i)=>mix(points[i],point,t));
    left.push(points[0]);
    right.unshift(points.at(-1));
  }
  return {left,right,point:points[0]};
}

function closestOnCurve(pointAt,target) {
  const merit=t=>distance(pointAt(t),target);
  const steps=24;
  let best=0, separation=merit(0);
  for(let i=1;i<=steps;i++) {
    const candidate=merit(i/steps);
    if (candidate<separation) { best=i; separation=candidate; }
  }
  let low=Math.max(0,(best-1)/steps),high=Math.min(1,(best+1)/steps);
  for(let i=0;i<22;i++) {
    const a=(2*low+high)/3,b=(low+2*high)/3;
    if(merit(a)<merit(b)) high=b;
    else low=a;
  }
  return (low+high)/2;
}

function closestOnLine([a,b],target) {
  const dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;
  return length?Math.max(0,Math.min(1,((target[0]-a[0])*dx+(target[1]-a[1])*dy)/length)):0;
}

export function ellipticalArc(start,end,[horizontal,vertical,rotation,large,sweep]) {
  let rx=Math.abs(horizontal), ry=Math.abs(vertical);
  if (!rx || !ry || samePoint(start,end)) return null;
  const angle=rotation*Math.PI/180, cos=Math.cos(angle), sin=Math.sin(angle);
  const dx=(start[0]-end[0])/2, dy=(start[1]-end[1])/2;
  const px=cos*dx+sin*dy, py=-sin*dx+cos*dy;
  const grow=Math.max(1,Math.hypot(px/rx,py/ry));
  rx*=grow;
  ry*=grow;
  const u=px/rx, v=py/ry;
  const ratio=u*u+v*v;
  const factor=(large===sweep?-1:1)*Math.sqrt(Math.max(0,1/ratio-1));
  const cx=factor*v*rx, cy=-factor*u*ry;
  const startAngle=Math.atan2((py-cy)/ry,(px-cx)/rx);
  let span=Math.atan2((-py-cy)/ry,(-px-cx)/rx)-startAngle;
  if(sweep && span<0) span+=2*Math.PI;
  if(!sweep && span>0) span-=2*Math.PI;
  const midpoint=mix(start,end,.5);
  return {
    span,
    radius: Math.max(rx,ry),
    parameters: fraction=>[rx,ry,rotation,+(Math.abs(span*fraction)>Math.PI),sweep],
    pointAt(t) {
      const a=startAngle+span*t, x=rx*Math.cos(a)+cx, y=ry*Math.sin(a)+cy;
      return [midpoint[0]+cos*x-sin*y,midpoint[1]+sin*x+cos*y];
    }
  };
}

export function insertNode(model,worldPoint,tolerance) {
  let best=null;
  model.contours.forEach((contour,path)=>{
    const {nodes,closed}=contour;
    const count=nodes.length+(closed&&!seam(contour)?1:0);
    for (let index=1;index<count;index++) {
      const next=nodes[index]||{type:'L',point:nodes[0].point};
      const localPoints=[nodes[index-1].point,...(next.controls||[]),next.point];
      const worldPoints=localPoints.map(point=>world(model,point));
      const arc=next.type==='A'?ellipticalArc(localPoints[0],next.point,next.arc):null;
      // The control hull bounds a Bézier segment.
      if (!arc && [0,1].some(axis=>worldPoints.every(point=>point[axis]<worldPoint[axis]-tolerance)||
        worldPoints.every(point=>point[axis]>worldPoint[axis]+tolerance))) continue;
      const pointAt=arc?t=>world(model,arc.pointAt(t)):t=>split(worldPoints,t).point;
      const t=worldPoints.length===2&&!arc?closestOnLine(worldPoints,worldPoint):closestOnCurve(pointAt,worldPoint);
      const hit=pointAt(t);
      const separation=distance(hit,worldPoint);
      if (separation>tolerance||distance(hit,worldPoints[0])<.001||
        distance(hit,worldPoints.at(-1))<.001) continue;
      if (!best||separation<best.separation) best={nodes,path,index,next,t,localPoints,separation,arc};
    }
  });
  if (!best) return null;
  const {nodes,path,index,next,t,localPoints,arc}=best;
  if (arc) {
    nodes.splice(index,0,{type:'A',point:arc.pointAt(t),arc:arc.parameters(t)});
    next.arc=arc.parameters(1-t);
    return path+':'+index;
  }
  const {left,right,point}=split(localPoints,t);
  const inserted={type:next.type==='A'?'L':next.type,point};
  if(next.controls) {
    inserted.controls=left.slice(1,-1);
    next.controls=right.slice(1,-1);
  }
  nodes.splice(index,0,inserted);
  return path+':'+index;
}

export function nodeObject(model) {
  const {object,contours}=model;
  if (isEllipse(object)) return {...object};
  if (object.kind==='path') return {...object,d:writePath(contours)};
  const {nodes,closed}=contours[0];
  const points=nodes.map(node=>node.point);
  if(object.kind==='line'&&points.length===2) {
    const [[x1,y1],[x2,y2]]=points;
    return {...object,x1,y1,x2,y2};
  }
  const {x1,y1,x2,y2,...properties}=object;
  return {...properties,kind:closed?'polygon':'polyline',points};
}
