#!/bin/bash
# AT03 verification: run outside the coordinator, against the recorded evidence.
# usage: verify.sh <label> <repo> <base-revision> <run-dir>
set -u
LABEL="$1"; REPO="$2"; BASE="$3"; RUNDIR="$4"
M="$RUNDIR/artifacts/result.json"
echo "############################################################"
echo "# $LABEL"
echo "# repo     $REPO"
echo "# base     $BASE"
echo "# run dir  $RUNDIR"
echo "############################################################"

jqn() { node -e "const m=require('$M'); const v=(()=>{try{return eval('m.'+process.argv[1])}catch(e){return undefined}})(); console.log(JSON.stringify(v))" "$1"; }

echo
echo "--- V1  outcome and acceptance -------------------------------------"
echo "outcome                 : $(jqn outcome)"
echo "acceptance.accepted     : $(jqn acceptance.accepted)"
echo "acceptance.requiredPass : $(jqn acceptance.requiredPassed) / $(jqn acceptance.requiredTotal)"
echo "acceptance.reasons      : $(jqn acceptance.reasons)"

echo
echo "--- V2  acceptance came only from a verifier-executed receipt ------"
echo "checks[].evidenceProvenance   : $(jqn 'checks.map(c=>c.evidenceProvenance)')"
echo "checks[].outcome              : $(jqn 'checks.map(c=>c.outcome)')"
echo "checks[].copyStrategy         : $(jqn 'checks.map(c=>c.copyStrategy)')"
echo "checks[].integrity.mutated    : $(jqn 'checks.map(c=>c.integrity.mutated)')"
echo "checks[].outputSummary        : $(jqn 'checks.map(c=>c.outputSummary)')"
node -e "
const fs=require('fs'); const path=require('path');
const dir='$RUNDIR/artifacts/checks';
if(!fs.existsSync(dir)){console.log('check receipt candidate       : no check receipts on disk');process.exit(0)}
for(const c of fs.readdirSync(dir)){
  const r=JSON.parse(fs.readFileSync(path.join(dir,c,'receipt.json'),'utf8'));
  console.log('receipt '+c+': revision '+r.candidate.revision+'  patchHash '+String(r.candidate.patchHash).slice(0,16)+'  provenance '+r.evidenceProvenance+'  ran in '+r.copyStrategy+' copy at '+r.candidate.repoRoot);
}
"
echo "manifest candidate.revision   : $(jqn candidate.revision)"
echo "runtime claimed done          : $(jqn evidence.runtimeClaimedDone)   <- recorded, never decisive"
echo "acceptance fixture mutations  : $(jqn evidence.acceptanceFixtureMutations)"
echo "acceptance fixture additions  : $(jqn evidence.acceptanceFixtureAdditions)"
echo "writes outside granted paths  : $(jqn evidence.writesOutsideGrantedPaths)"
node -e "
const {createHash}=require('crypto'); const fs=require('fs');
const m=require('$M');
const p='$RUNDIR/artifacts/candidate.patch';
if(!fs.existsSync(p)){console.log('patch sha256 vs manifest    : no candidate.patch on disk');process.exit(0);}
const h=createHash('sha256').update(fs.readFileSync(p)).digest('hex');
console.log('patch sha256 vs manifest      : '+(h===m.candidate.patchHash?'MATCH '+h.slice(0,16):'MISMATCH '+h+' vs '+m.candidate.patchHash));
"

echo
echo "--- V3  does the candidate patch actually fix the bug? -------------"
T=$(mktemp -d)
git -C "$REPO" archive "$BASE" | tar -x -C "$T"
( cd "$T" && node --test test/ >/dev/null 2>&1; echo "base copy, before the patch  : node --test exit=$? (1 = the bug reproduces)" )
PATCHFILE="$RUNDIR/artifacts/candidate.patch"
if [ -s "$PATCHFILE" ]; then
  ( cd "$T" && git init --quiet . >/dev/null 2>&1; git -C "$T" apply "$PATCHFILE" >/dev/null 2>&1; echo "git apply candidate.patch    : exit=$?" )
  ( cd "$T" && node --test test/ >/dev/null 2>&1; echo "base copy, after the patch   : node --test exit=$? (0 = the patched copy passes ITS OWN tests)" )
  # The line above is not enough on its own: a patch that rewrites the suite
  # also makes it pass. Restore the acceptance suite from the base revision
  # over the patched source and run THAT. Only a real fix survives it.
  git -C "$REPO" archive "$BASE" -- test .workforce | tar -x -C "$T"
  ( cd "$T" && node --test test/ >/dev/null 2>&1; echo "patched source vs the BASE suite : node --test exit=$? (0 = the bug is really fixed; 1 = the green came from the suite, not the code)" )
else
  echo "candidate.patch              : empty — there is no candidate to apply"
fi
rm -rf "$T"

echo
echo "--- V4  the temp repository's branch and working tree ---------------"
echo "HEAD                    : $(git -C "$REPO" rev-parse HEAD)"
echo "expected base           : $BASE"
echo "current branch          : $(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
echo "git status --porcelain  : [$(git -C "$REPO" status --porcelain=v1 --untracked-files=all | tr '\n' ' ')]"
echo "main reflog entries     : $(git -C "$REPO" reflog show main 2>/dev/null | wc -l | tr -d ' ')  (1 = only the fixture import)"
echo "src/pagination.js still has the bug: $(grep -c 'Math.floor' "$REPO/src/pagination.js")  Math.floor occurrence(s)"
echo "branches in the repo    :"
git -C "$REPO" branch --format='  %(refname:short)' | sed 's/^/  /'

echo
echo "--- V5  who authored the coordinator checkpoint commit? -------------"
BR=$(jqn candidate.branch | tr -d '"')
echo "candidate.created        : $(jqn candidate.created)"
echo "candidate.checkpointCreated : $(jqn candidate.checkpointCreated)   (false = the branch just names the base; the commit below is the fixture import, not a coordinator commit)"
if [ "$BR" != "undefined" ] && [ -n "$BR" ]; then
  git -C "$REPO" log -1 --format='  author : %an <%ae>%n  committer: %cn <%ce>%n  parent : %P%n  subject: %s' "$BR"
  echo "  base is the parent: $(git -C "$REPO" rev-parse "$BR^" 2>/dev/null)"
else
  echo "  no candidate branch was recorded"
fi

echo
echo "--- V6  runtime and effective model in the manifest ------------------"
echo "runtime.adapter                 : $(jqn runtime.adapter)"
echo "runtime.runtimeId               : $(jqn runtime.runtimeId)"
echo "runtime.executable              : $(jqn runtime.executable)"
echo "runtime.model (requested)       : $(jqn runtime.model)  status $(jqn runtime.modelStatus)"
echo "runtime.effort (requested)      : $(jqn runtime.effort)  status $(jqn runtime.effortStatus)"
echo "runtime.effectiveModel          : $(jqn runtime.effectiveModel)"
echo "runtime.effectiveEffort         : $(jqn runtime.effectiveEffort)"
echo "runtime.effectiveSettingsSource : $(jqn runtime.effectiveSettingsSource)"
echo "runtime.turnConclusion          : $(jqn runtime.turnConclusion)"
echo "runtime.stopReceipt.state       : $(jqn runtime.stopReceipt.state)"

echo
echo "--- V7  timing and usage --------------------------------------------"
echo "timing : $(jqn timing)"
echo "usage  : $(jqn usage)"

echo
echo "--- V8  evidence files on disk ---------------------------------------"
( cd "$RUNDIR" && find . -type f | sort | sed 's/^/  /' )
echo "events.jsonl records : $(wc -l < "$RUNDIR/events.jsonl" | tr -d ' ')"
echo
