#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Db } from './db.js';
import {ProviderSecrets} from './provider-secrets.js';
import {WriterLock} from './writer-lock.js';

const HELP = `obsidian-relay CLI

  relay code                 create a new pairing code (valid 15 min)
  relay devices              list connected devices
  relay revoke <id>          disconnect one device
  relay reset                revoke all devices and codes
  relay quick-key [folder]   create a quick-capture key (for Shortcuts / widgets)
  relay rotate-key           rotate encrypted credentials while the server is stopped
`;

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const cfg = loadConfig();
  const db = await Db.open(cfg.dbPath);
  try {
  switch (cmd) {
    case 'rotate-key':{const lock=await WriterLock.acquire(cfg.vault.root);try{console.log('Encrypted records rotated:',(await ProviderSecrets.rotate(cfg,db)).rotated);}finally{await lock.release();}break;}
    case 'code': {
      const { code, expiresAt } = db.createPairingCode();
      console.log(`Pairing code: ${code}`);
      console.log(`Valid until:  ${new Date(expiresAt).toLocaleString()}`);
      console.log(`Open ${cfg.publicUrl} on the phone (add to home screen first) and enter the code.`);
      break;
    }
    case 'devices': {
      const list = db.listDevices();
      if (!list.length) console.log('No devices.');
      for (const d of list) {
        const seen = d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'never';
        console.log(`#${d.id}\t${d.kind}\t${d.name}\tlast seen: ${seen}${d.folder ? `\tfolder: ${d.folder}` : ''}`);
      }
      break;
    }
    case 'revoke': {
      const id = Number(arg);
      console.log(db.revokeDevice(id) ? `Device #${id} revoked.` : `Device #${id} not found.`);
      break;
    }
    case 'reset': {
      db.resetPairingCodes();
      console.log(`Revoked ${db.revokeAll()} device(s), cleared pairing codes.`);
      break;
    }
    case 'quick-key': {
      const { token, device } = db.createDevice('Быстрая запись', 'quick', arg);
      console.log(`Quick-capture key (#${device.id}), shown once:\n${token}`);
      console.log(`POST ${cfg.publicUrl}/api/send  JSON: {"token": "...", "text": "...", "chat": "quick"}`);
      break;
    }
    default:
      console.log(HELP);
  }
  } finally {db.close();}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
