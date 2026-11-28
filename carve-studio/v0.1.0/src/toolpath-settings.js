export function operationDefaults(thickness) {
  const rates = {safeZ:5,feed:800,plunge:250,rpm:12000};
  return {
    profile:{...rates,depth:thickness,stepdown:1},
    drill:{...rates,depth:thickness,stepdown:1},
    slot:{...rates,depth:thickness*.5,stepdown:1},
    vgroove:{...rates,depth:thickness*.3},
    'vgroove-flat':{...rates,depth:thickness*.3,stepdown:1},
    pocket:{...rates,depth:thickness*.5,stepdown:1}
  };
}

export function restoreToolpathSettings(saved, thickness) {
  const {operations:stored, tools:storedTools, vgrooveFlatBottom, vgrooveFlatStepdown, ...settings} = saved;
  const operations = operationDefaults(thickness);
  const tools = {...storedTools};
  const sharedLegacy = ['stepdown','safeZ','feed','plunge','rpm'];
  for (const [operation,fields] of Object.entries(operations)) {
    if (operation==='vgroove-flat') continue;
    for (const key of Object.keys(fields)) {
      const value = stored?.[operation]?.[key];
      const legacy = sharedLegacy.includes(key) ? settings[key] : undefined;
      if (value!==undefined) fields[key] = value;
      else if (Number.isFinite(Number(legacy))) fields[key] = Number(legacy);
    }
  }

  const flat = operations['vgroove-flat'];
  if (stored?.['vgroove-flat']) {
    for (const key of Object.keys(flat)) flat[key] = stored['vgroove-flat'][key] ?? flat[key];
  } else if (vgrooveFlatBottom!==undefined || vgrooveFlatStepdown!==undefined || settings.vgrooveClearanceTool) {
    // The previous flat-bottom toggle shared the standard V Groove settings.
    Object.assign(flat,operations.vgroove);
    if (Number.isFinite(vgrooveFlatStepdown) && vgrooveFlatStepdown>0) flat.stepdown = vgrooveFlatStepdown;
    tools['vgroove-flat'] = tools.vgroove || null;
  }
  return {...settings,tools,operations};
}
