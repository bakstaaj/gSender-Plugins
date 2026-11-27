import {canDeleteNode, createNodeModel, deleteNode, insertNode, nodeHandles, nodeObject, updateNode} from './node-editing.js';

export function setupNodeEditor({overlay, fields, status, removeButton, getObject, getView, selectAt, preview, commit, snap, clearSnap}) {
  let object, model, selection, gesture, geometryError;
  const handles = () => model ? nodeHandles(model, selection) : [];
  const activeHandle = () => handles().find(handle => handle.key === selection?.key);

  function element(tag, attrs) {
    const node = document.createElementNS(overlay.namespaceURI, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  }

  function render() {
    const {height, scale} = getView();
    const current = handles();
    const selected = current.find(handle => handle.key === selection?.key);
    const size = 7 / scale;
    const guides = current.filter(handle => handle.origin).map(({point: [x,y], origin: [ox,oy]}) =>
      element('line', {class: 'node-guide', x1: ox, y1: height-oy, x2: x, y2: height-y}));
    const markers = current.map(({key, kind, point: [x,y]}) => {
      const attrs = {class: 'node-handle'+(selected?.key === key ? ' active' : ''), 'data-node-key': key};
      return kind === 'node'
        ? element('rect', {...attrs, x: x-size/2, y: height-y-size/2, width: size, height: size})
        : element('circle', {...attrs, cx: x, cy: height-y, r: size/2});
    });
    overlay.replaceChildren(...guides, ...markers);
    status.textContent = geometryError || (current.length
      ? model.contours.length
        ? 'Drag a node or curve handle. Double-click an edge to add a node.'
        : 'Drag the center or a radius handle.'
      : 'Click a vector to show its nodes.');
    fields.forEach((field, axis) => {
      field.disabled = !selected || selected.kind === 'radius';
      if (document.activeElement !== field || field.disabled) {
        field.value = selected ? Number(selected.point[axis].toFixed(4)) : '';
      }
    });
    removeButton.disabled = !model || !canDeleteNode(model, selected);
  }

  function refresh() {
    const next = getObject();
    if (next?.id !== object?.id) selection = undefined;
    object = next;
    gesture = undefined;
    geometryError = '';
    try {
      model = object ? createNodeModel(object, getView().height) : undefined;
    } catch (error) {
      model = undefined;
      geometryError = error.message;
    }
    if (selection && !activeHandle()) selection = undefined;
    render();
  }

  function cancel() {
    if (!gesture) return false;
    model = gesture.baseline;
    if (gesture.preview) preview(object);
    gesture = undefined;
    clearSnap();
    render();
    return true;
  }

  function pointerDown(point, event) {
    if (gesture) return;
    const key = event.target.closest('[data-node-key]')?.dataset.nodeKey;
    const handle = handles().find(item => item.key === key);
    if (!handle) {
      selectAt(point, event.target);
      return;
    }
    selection = handle;
    gesture = {id: event.pointerId, start: point, handle, baseline: model,
      clientX: event.clientX, clientY: event.clientY};
    render();
  }

  function pointerMove(point, event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const {start, handle, clientX, clientY, baseline} = gesture;
    if (!gesture.preview && Math.hypot(event.clientX-clientX, event.clientY-clientY) <= 3) return;
    let target = snap({
      x: handle.point[0]+point.x-start.x,
      y: handle.point[1]+point.y-start.y
    }, object.id);
    if (handle.kind === 'radius' && object.kind === 'ellipse') {
      target = handle.key === 'radius-x' ? {...target, y: object.cy} : {...target, x: object.cx};
    }
    model = structuredClone(baseline);
    updateNode(model, handle, [target.x, target.y]);
    gesture.preview = true;
    const handlePosition = activeHandle().point;
    gesture.changed = Math.hypot(handlePosition[0]-handle.point[0], handlePosition[1]-handle.point[1]) > 1e-7;
    preview(gesture.changed ? nodeObject(model) : object);
    render();
  }

  function pointerUp(point, event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    pointerMove(point, event);
    if (!gesture.changed) {
      cancel();
      return;
    }
    gesture = undefined;
    clearSnap();
    commit(nodeObject(model));
  }

  function insert(point, target) {
    if (!model?.contours.length || target.closest('[data-node-key]')) return;
    if (handles().some(handle => Math.hypot(point.x-handle.point[0], point.y-handle.point[1]) <= 5/getView().scale)) return;
    const key = insertNode(model, [point.x, point.y], 10/getView().scale);
    if (!key) return;
    selection = {key};
    commit(nodeObject(model));
  }

  function remove() {
    const selected = activeHandle();
    if (!model || !deleteNode(model, selected)) return;
    selection = undefined;
    commit(nodeObject(model));
  }

  fields.forEach((field, axis) => {
    let recorded = false;
    field.addEventListener('focus', () => { recorded = false; });
    field.addEventListener('input', () => {
      const selected = activeHandle();
      const value = field.valueAsNumber;
      if (!selected || !Number.isFinite(value) || value === selected.point[axis]) return;
      const point = [...selected.point];
      point[axis] = value;
      updateNode(model, selected, point);
      commit(nodeObject(model), !recorded);
      recorded = true;
    });
    field.addEventListener('blur', () => {
      const selected = activeHandle();
      field.value = selected ? Number(selected.point[axis].toFixed(4)) : '';
    });
  });
  removeButton.onclick = remove;
  return {refresh, render, cancel, pointerDown, pointerMove, pointerUp, insert, remove};
}
