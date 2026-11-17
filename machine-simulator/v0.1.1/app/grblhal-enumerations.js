const alarms=[
  'Initialization required. Re-homing is recommended.',
  'Hard limit has been triggered. Machine position may be lost; re-homing is recommended.',
  'Soft limit alarm. The target exceeds machine travel.',
  'Reset while in motion. Machine position may be lost.',
  'Probe contact was not detected before the probe move completed.',
  'Probe was already active before the probe move started.',
  'Homing failed. Check the limit switches and homing direction.',
  'Homing failed because a limit switch was not found.',
  'Safety door is open.',
  'Jog target exceeds machine travel.'
];
const errors=[
  '',
  'G-code words consist of a letter and a value. Letter was not found.',
  'Missing the expected G-code word value or numeric value format is not valid.',
  "Grbl '$' system command was not recognized or supported.",
  'Negative value for an expected positive value.',
  'Homing is not enabled in your settings.',
  'Minimum step pulse must be greater than 3 microseconds.',
  'EEPROM read failed. Defaults may be used.',
  "Grbl '$' command cannot be used unless Idle or Alarm state.",
  'G-code commands are locked out during alarm or jog state.',
  'Soft limits cannot be enabled without homing enabled.',
  'Max characters per line exceeded.',
  "Grbl '$' setting value exceeds the maximum step rate.",
  'Safety door opened and motion was paused.',
  'Build info or startup line exceeded its maximum length.',
  'Jog target exceeds machine travel.',
  'Jog command has no axis words.',
  'Laser mode disabled. PWM output is required.',
  '',
  '',
  'G-code command is unsupported or invalid.',
  'Modal group violation.',
  'Undefined feed rate.',
  'Integer value required.',
  'Two G-code commands that both require XYZ axis words were detected.',
  'Repeated word found in command.',
  'A G-code command requires XYZ axis words, but none were detected.',
  'Invalid line number.',
  'G-code command is missing a required P or L value.',
  'G59.x coordinate systems are not supported.',
  'G53 is only valid with G0 or G1.',
  'Unused axis words were found while motion mode G80 is active.',
  'Arc command has no axis words in the selected plane.',
  'Arc target is invalid.',
  'Arc radius error.',
  'Arc command is missing required IJK offset words.',
  'Unused G-code words remain in the command.',
  'Dynamic tool length offset is assigned to an unsupported axis.',
  'Tool number exceeds the maximum supported value.'
];
const metadata={
  0:['Step pulse time','microseconds',6,'#0.0','2.0',''],
  1:['Step idle delay','milliseconds',5,'####0','','65535'],
  2:['Step pulse invert','',4,'','',''],
  3:['Step direction invert','',4,'','',''],
  4:['Invert step enable pin','',0,'false,true','',''],
  5:['Invert limit pins','',0,'false,true','',''],
  6:['Invert probe pin','',0,'false,true','',''],
  10:['Status report options','',1,'','',''],
  11:['Junction deviation','mm',6,'#0.000','0.0',''],
  12:['Arc tolerance','mm',6,'#0.000','0.0',''],
  13:['Report in inches','',0,'false,true','',''],
  20:['Soft limits enable','',0,'false,true','',''],
  21:['Hard limits enable','',0,'false,true','',''],
  22:['Homing cycle enable','',1,'','',''],
  23:['Homing direction invert','',4,'','',''],
  24:['Homing locate feed rate','mm/min',6,'####0.0','0.0',''],
  25:['Homing search seek rate','mm/min',6,'####0.0','0.0',''],
  26:['Homing switch debounce delay','ms',5,'####0','','65535'],
  27:['Homing switch pull-off distance','mm',6,'####0.000','0.0',''],
  30:['Maximum spindle speed','rpm',6,'#####0.0','0.0',''],
  31:['Spindle mode','rpm',6,'#####0.0','0.0',''],
  32:['Laser mode','',0,'false,true','',''],
  100:['X-axis travel resolution','step/mm',6,'####0.000','0.0',''],
  101:['Y-axis travel resolution','step/mm',6,'####0.000','0.0',''],
  102:['Z-axis travel resolution','step/mm',6,'####0.000','0.0',''],
  110:['X-axis maximum rate','mm/min',6,'#####0.0','0.0',''],
  111:['Y-axis maximum rate','mm/min',6,'#####0.0','0.0',''],
  112:['Z-axis maximum rate','mm/min',6,'#####0.0','0.0',''],
  120:['X-axis acceleration','mm/sec^2',6,'#####0.0','0.0',''],
  121:['Y-axis acceleration','mm/sec^2',6,'#####0.0','0.0',''],
  122:['Z-axis acceleration','mm/sec^2',6,'#####0.0','0.0',''],
  130:['X-axis maximum travel','mm',6,'#####0.0','0.0',''],
  131:['Y-axis maximum travel','mm',6,'#####0.0','0.0',''],
  132:['Z-axis maximum travel','mm',6,'#####0.0','0.0','']
};

function settingRow(id,descriptions={}){
  const base=metadata[id]||[];
  const description=(descriptions[`$${id}`]||'Controller setting').split(/,\s*/,2);
  const name=base[0]||description[0];
  const unit=base[1]??description[1]??'';
  const type=base[2]??5,format=base[3]??'#####0',min=base[4]??'',max=base[5]??'';
  return [id,35,name,unit,type,format,min,max,0,0];
}
function sendRows(reply,rows){for(const row of rows)reply(row);reply('ok');}

export function handleGrblHalEnumeration(command,settings,descriptions,reply){
  const ids=Object.keys(settings).map(key=>Number(key.slice(1))).sort((a,b)=>a-b);
  const rows=ids.map(id=>settingRow(id,descriptions));
  switch(command.toUpperCase()){
    case '$ES':sendRows(reply,rows.map(row=>`[SETTING:${row.join('|')}]`));return true;
    case '$ESH':sendRows(reply,rows.map(row=>row.join('\t')));return true;
    case '$EG':sendRows(reply,['[SETTINGGROUP:0|0|Root]','[SETTINGGROUP:35|0|General]']);return true;
    case '$EA':sendRows(reply,alarms.map((description,id)=>`[ALARMCODE:${id}||${description}]`));return true;
    case '$EE':sendRows(reply,errors.map((description,id)=>`[ERRORCODE:${id}||${description}]`));return true;
    case '$SPINDLESH':sendRows(reply,['[SPINDLE:0|0|0|*DV|PWM|1000.0,0.0]']);return true;
    case '$E*':
      for(const [id,description] of alarms.entries())reply(`[ALARMCODE:${id}||${description}]`);
      for(const [id,description] of errors.entries())reply(`[ERRORCODE:${id}||${description}]`);
      reply('[SETTINGGROUP:0|0|Root]');reply('[SETTINGGROUP:35|0|General]');
      for(const row of rows)reply(`[SETTING:${row.join('|')}]`);
      reply('ok');return true;
    default:return false;
  }
}
