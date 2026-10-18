export function recordToIso2709(record) {
  const leaderStr = (record.leader || '00000nam a2200000 a 4500').padEnd(24, ' ');
  let leader = Buffer.from(leaderStr, 'utf8');
  
  // Set default fixed positions if they're default spaces or zeroes
  leader[9] = 0x61; // 'a' - UCS/Unicode
  leader[10] = 0x32; // '2' - indicator count
  leader[11] = 0x32; // '2' - subfield code length
  leader[20] = 0x34; // '4'
  leader[21] = 0x35; // '5'
  leader[22] = 0x30; // '0'
  leader[23] = 0x30; // '0'

  let directory = '';
  let dataBlocks = [];

  const addField = (tag, dataStr) => {
    const dataBuf = Buffer.from(dataStr, 'utf8');
    const length = dataBuf.length + 1; // +1 for field terminator
    dataBlocks.push(dataBuf);
    dataBlocks.push(Buffer.from([0x1E]));
    return length;
  };

  let currentOffset = 0;

  if (record.controlFields) {
    for (const cf of record.controlFields) {
      const len = addField(cf.tag, cf.value);
      directory += cf.tag + len.toString().padStart(4, '0') + currentOffset.toString().padStart(5, '0');
      currentOffset += len;
    }
  }

  if (record.dataFields) {
    for (const df of record.dataFields) {
      let fieldStr = (df.ind1 || ' ') + (df.ind2 || ' ');
      if (df.subfields) {
        for (const sf of df.subfields) {
          fieldStr += String.fromCharCode(0x1F) + sf.code + sf.value;
        }
      }
      const len = addField(df.tag, fieldStr);
      directory += df.tag + len.toString().padStart(4, '0') + currentOffset.toString().padStart(5, '0');
      currentOffset += len;
    }
  }

  directory += String.fromCharCode(0x1E); // Directory terminator
  const dirBuf = Buffer.from(directory, 'utf8');
  
  const baseAddress = 24 + dirBuf.length;
  
  // Total length = base address + data size + 1 (record terminator)
  let dataSize = 0;
  for (const b of dataBlocks) dataSize += b.length;
  const totalLength = baseAddress + dataSize + 1;

  // Update leader lengths
  const lenStr = totalLength.toString().padStart(5, '0');
  const baseStr = baseAddress.toString().padStart(5, '0');
  
  lenStr.split('').forEach((c, i) => leader[i] = c.charCodeAt(0));
  baseStr.split('').forEach((c, i) => leader[12 + i] = c.charCodeAt(0));

  const resultBlocks = [leader, dirBuf, ...dataBlocks, Buffer.from([0x1D])];
  return Buffer.concat(resultBlocks);
}

export function iso2709ToRecord(buffer) {
  if (buffer.length < 24) throw new Error("Buffer too small for ISO2709 leader");
  
  const leader = buffer.toString('utf8', 0, 24);
  const totalLen = parseInt(leader.substring(0, 5), 10);
  const baseAddress = parseInt(leader.substring(12, 17), 10);
  
  if (buffer.length < totalLen) {
    // If we received a truncated buffer, we'll try to parse what we have, 
    // but ideally we should throw. Let's just proceed with what we have.
  }
  
  const record = {
    leader,
    controlFields: [],
    dataFields: []
  };

  // Parse directory
  let dirOffset = 24;
  const entries = [];
  while (dirOffset < baseAddress - 1) { // -1 for the directory terminator (0x1E)
    const tag = buffer.toString('utf8', dirOffset, dirOffset + 3);
    const len = parseInt(buffer.toString('utf8', dirOffset + 3, dirOffset + 7), 10);
    const pos = parseInt(buffer.toString('utf8', dirOffset + 7, dirOffset + 12), 10);
    entries.push({ tag, len, pos });
    dirOffset += 12;
  }

  for (const entry of entries) {
    const fieldStart = baseAddress + entry.pos;
    const fieldEnd = fieldStart + entry.len - 1; // -1 for field terminator
    const fieldData = buffer.toString('utf8', fieldStart, fieldEnd);
    
    if (entry.tag.startsWith('00')) {
      record.controlFields.push({ tag: entry.tag, value: fieldData });
    } else {
      if (fieldData.length < 2) continue; // Invalid data field
      const ind1 = fieldData.charAt(0);
      const ind2 = fieldData.charAt(1);
      
      const subfields = [];
      const parts = fieldData.substring(2).split(String.fromCharCode(0x1F));
      for (let i = 1; i < parts.length; i++) { // Start at 1 because 0 is before first delimiter
        const part = parts[i];
        if (part.length > 0) {
          subfields.push({
            code: part.charAt(0),
            value: part.substring(1)
          });
        }
      }
      
      record.dataFields.push({
        tag: entry.tag,
        ind1,
        ind2,
        subfields
      });
    }
  }

  return record;
}
