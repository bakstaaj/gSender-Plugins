const STORAGE_KEY = 'carve-studio-tools-v1';
const TOOL_TYPES = {endmill:'Flat end mill',drill:'Drill bit',vbit:'V-bit'};
export const OPERATION_TOOL_TYPES = {profile:'endmill',drill:'drill',vgroove:'vbit',pocket:'endmill'};

export function readTool(input) {
  if (!input || typeof input.id !== 'string' || !input.id || input.id === 'saved' ||
    typeof input.name !== 'string' || !input.name.trim() || !Object.hasOwn(TOOL_TYPES,input.type)) return null;

  const {id,type} = input;
  const name = input.name.trim().slice(0,60);
  const [number,diameter,angle,stepdown,feed,plunge,rpm] =
    ['number','diameter','angle','stepdown','feed','plunge','rpm'].map(key=>Number(input[key]));
  if (!Number.isSafeInteger(number) || number < 1 || number > 999 ||
    !Number.isFinite(diameter) || diameter < .01 || diameter > 10000 ||
    ![feed,plunge,rpm].every(value=>Number.isFinite(value) && value > 0) ||
    (type === 'vbit' ? !Number.isFinite(angle) || angle <= 0 || angle >= 180 :
      !Number.isFinite(stepdown) || stepdown < .001)) return null;
  return {id,name,type,number,diameter,angle:type==='vbit'?angle:null,stepdown:type==='vbit'?null:stepdown,feed,plunge,rpm};
}

export function sameCutter(a,b) {
  return a.type === b.type && a.diameter === b.diameter && a.angle === b.angle;
}

export function toolLabel(tool) {
  return 'T'+tool.number+' · '+tool.name;
}

export function initToolLibrary(onChange) {
  const get = id=>document.getElementById(id);
  const dialog = get('tool-library-dialog');
  const list = get('library-tools');
  const form = get('library-tool-form');
  const fields = form.elements;
  const status = get('library-status');
  const remove = get('remove-library-tool');
  let editingId = '';
  let tools = [];
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(saved)) tools = saved.map(readTool).filter(Boolean);
  } catch {
    // The manual settings are always available.
  }

  function updateType() {
    const vbit = fields.type.value === 'vbit';
    get('library-angle-field').hidden = !vbit;
    get('library-stepdown-field').hidden = vbit;
    fields.angle.disabled = !vbit;
    fields.stepdown.disabled = vbit;
  }

  function showTool(tool) {
    editingId = tool?.id || '';
    fields.name.value = tool?.name || '';
    fields.type.value = tool?.type || 'endmill';
    const used = new Set(tools.map(item=>item.number));
    const nextNumber = Array.from({length:999},(_,index)=>index+1).find(number=>!used.has(number));
    for (const key of ['number','diameter','angle','stepdown','feed','plunge','rpm']) {
      fields[key].value = tool?.[key] ?? (key==='number' ? nextNumber ?? '' : '');
    }
    updateType();
    remove.hidden = !editingId;
    status.textContent = '';
  }

  function renderList() {
    list.replaceChildren(new Option('New tool',''), ...tools.map(tool=>new Option(toolLabel(tool) + ' · ' + TOOL_TYPES[tool.type],tool.id)));
    list.value = editingId;
  }

  function persist(next) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      tools = next;
      onChange();
      return true;
    } catch {
      status.textContent = 'Could not save the tool library in this gSender profile.';
      return false;
    }
  }

  function openLibrary(tool) {
    if (dialog.open) return;
    showTool(tool);
    renderList();
    dialog.showModal();
  }
  get('open-tool-library').addEventListener('click',()=>openLibrary(tools.find(tool=>tool.id===editingId)));
  get('add-profile-tool').addEventListener('click',()=>{
    openLibrary();
    fields.name.focus();
  });
  list.addEventListener('change',()=>showTool(tools.find(tool=>tool.id===list.value)));
  fields.type.addEventListener('change',updateType);
  form.addEventListener('submit',event=>{
    event.preventDefault();
    const input = Object.fromEntries(new FormData(form));
    const tool = readTool({...input,id:editingId || crypto.randomUUID()});
    if (!tool) {
      status.textContent = 'Enter a name and valid tool values.';
      return;
    }
    if (tools.some(item=>item.id!==editingId && item.number===tool.number)) {
      status.textContent = 'That tool number is already in the library.';
      return;
    }
    const next = [...tools.filter(item=>item.id!==editingId),tool].sort((a,b)=>a.number-b.number);
    if (persist(next)) {
      showTool(tool);
      renderList();
      status.textContent = 'Tool saved.';
    }
  });
  remove.addEventListener('click',()=>{
    if (persist(tools.filter(tool=>tool.id!==editingId))) {
      showTool();
      renderList();
      status.textContent = 'Tool removed from the library.';
    }
  });
  return {get tools(){return tools;}};
}
