import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { readLegacyAdoptionEvidence } from "./legacy-adoption-evidence.js";
it("reads only the exact native journal and never upgrades provider evidence to result delivery",()=>{
 const dir=mkdtempSync("/Volumes/NVM/AI_Agent_Runtime/tmp/legacy-adoption-"),path=join(dir,"journal.db"),session="ses_1234567890ABC",other="ses_abcdefghijABC";const db=new DatabaseSync(path);
 try {db.exec("CREATE TABLE session_v2(id TEXT); CREATE TABLE session_message(session_id TEXT, seq INTEGER, type TEXT, data TEXT);");db.prepare("INSERT INTO session_v2 VALUES (?)").run(session);db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?)").run(session,1,"assistant",JSON.stringify({content:[{type:"tool",name:"write",state:{status:"completed",output:"PRIVATE"}}]}));db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?)").run(session,2,"compaction",JSON.stringify({status:"running",summary:"PRIVATE"}));db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?)").run(other,9,"assistant",JSON.stringify({content:[]}));db.close();
 expect(readLegacyAdoptionEvidence({journalPath:path,runBoundSessionId:session})).toEqual({state:"observed",lastSeq:2,messageType:"compaction",compactionStatus:"running",toolStates:[],delivery:"unknown",requiresReconciliation:true});
 expect(readLegacyAdoptionEvidence({journalPath:path,runBoundSessionId:other})).toEqual({state:"session_not_found",delivery:"unknown",requiresReconciliation:true});
 expect(()=>readLegacyAdoptionEvidence({journalPath:path,runBoundSessionId:"../invalid"})).toThrow("legacy_adoption_invalid_session_id");
 }finally{try{db.close()}catch{}rmSync(dir,{recursive:true,force:true})}
});
it("fails closed for malformed or oversized final messages",()=>{
 const dir=mkdtempSync("/Volumes/NVM/AI_Agent_Runtime/tmp/legacy-adoption-"),path=join(dir,"journal.db"),session="ses_1234567890ABC",db=new DatabaseSync(path);
 try{db.exec("CREATE TABLE session_v2(id TEXT); CREATE TABLE session_message(session_id TEXT, seq INTEGER, type TEXT, data TEXT);");db.prepare("INSERT INTO session_v2 VALUES (?)").run(session);const put=db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?)");put.run(session,1,"assistant","{");db.close();expect(readLegacyAdoptionEvidence({journalPath:path,runBoundSessionId:session}).state).toBe("evidence_unavailable");const db2=new DatabaseSync(path);db2.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?)").run(session,2,"assistant","x".repeat(262145));db2.close();expect(readLegacyAdoptionEvidence({journalPath:path,runBoundSessionId:session}).state).toBe("evidence_unavailable");}finally{try{db.close()}catch{}rmSync(dir,{recursive:true,force:true})}
});
