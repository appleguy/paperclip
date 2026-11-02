import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Captures a newly-created private workspace before child launch. This does not
 * prove OS peer identity of a subsequent HTTP request or exclude vendor plugins. */
export function captureAntigravityWorkspace(path:string) {
 if(!isAbsolute(path))throw new Error("Antigravity workspace must be absolute");
 const canonical=realpathSync(path), st=lstatSync(path,{bigint:true});
 if(canonical!==path||!st.isDirectory()||st.isSymbolicLink()||(process.platform!=="win32"&&((st.mode&0o077n)!==0n||st.uid!==BigInt(process.getuid!()))))throw new Error("Antigravity workspace must be private and canonical");
 const assertUnchanged=()=>{const next=lstatSync(path,{bigint:true});if(realpathSync(path)!==canonical||!next.isDirectory()||next.isSymbolicLink()||next.dev!==st.dev||next.ino!==st.ino||(process.platform!=="win32"&&((next.mode&0o077n)!==0n||next.uid!==st.uid)))throw new Error("Antigravity workspace identity changed");};
 return Object.freeze({path:canonical,assertUnchanged});
}
