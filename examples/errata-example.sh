#!/usr/bin/env bash
# 已发布版本勘误附记 端到端调用示例。
#
# 流程：建草稿 → 发布第 1 版 → 对该版快照中的事件 / 「先于」关系登记附记
#       → 访客视图看到生效附记（出处可被精确遮盖）
#       → 携「所见附记号」替代（旧附记保留，可查替代链）
#       → 并发冲突：两人同时替代仅一个成功，冲突方取得当前附记且不落库
#       → 撤回目标版：拒绝新登记、访客不可见，编辑者仍可查旧附记
#       → 发新版不继承；404/422/400 各类拒绝。
#
# 依赖：curl 与 node（本应用本身就需要 node，用于解析 JSON）。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/errata-example.sh
# 可重复运行（标题带时间戳，避免与历史数据互相干扰）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
TS="$(date +%s)"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
code_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
latest_no() { curl -s "$BASE/api/public/versions" | jfield 'd.currentVersionNo'; }

say "0) 口令检查（错误口令应 401）"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" \
  -H 'X-Editor-Token: wrong-token' -d '{}' "$BASE/api/editor/versions/1/errata")
[ "$code" = 401 ] && echo "OK：错误口令返回 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 建草稿：2 个事件 + 主张 + 一条先于关系，并发布第 1 版"
E1=$(post "$BASE/api/editor/events" -d '{"title":"勘误示例动员会 '$TS'"}' | jfield 'd.event.id')
E2=$(post "$BASE/api/editor/events" -d '{"title":"勘误示例通水会 '$TS'"}' | jfield 'd.event.id')
C1=$(post "$BASE/api/editor/events/$E1/claims" \
  -d '{"precision":"day","year":1958,"month":9,"day":12,"source":"李宝山口述 '$TS'"}' | jfield 'd.claim.id')
C2=$(post "$BASE/api/editor/events/$E2/claims" \
  -d '{"precision":"month","year":1959,"month":5,"source":"志书 87 页 '$TS'"}' | jfield 'd.claim.id')
RID=$(post "$BASE/api/editor/relations" \
  -d '{"earlierId":'"$E1"',"laterId":'"$E2"',"source":"二人一致 '$TS'"}' | jfield 'd.relation.id')
V=$(post "$BASE/api/editor/publish" \
  -d '{"selection":[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'}],"baseVersionNo":'"$(latest_no)"',"note":"勘误示例版","editor":"示例脚本"}' \
  | jfield 'd.versionNo')
echo "已发布第 $V 版；事件快照编号 $E1、$E2；关系快照编号 $RID"

say "2) 对该版快照事件 $E1 登记首条勘误附记（快照对象编号 + 说明 + 出处）"
ER1=$(post "$BASE/api/editor/versions/$V/errata" -d '{
  "targetType":"event","targetId":'"$E1"',
  "content":"经核对档案，动员会具体应为 1958 年 10 月（原快照日期不改，仅作附记）",
  "source":"县档案馆全宗 03 第 12 页 '"$TS"'","editor":"志愿者小王"}')
echo "$ER1" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log(`附记 #${d.erratum.erratumId}（第 ${d.erratum.versionNo} 版，${d.erratum.targetType} #${d.erratum.targetId}） 登记于 ${d.erratum.createdAt} UTC`);'
FIRST_ID=$(echo "$ER1" | jfield 'd.erratum.erratumId')

say "3) 对「先于」关系 $RID 也登记一条"
post "$BASE/api/editor/versions/$V/errata" -d '{
  "targetType":"relation","targetId":'"$RID"',
  "content":"二人后又回忆，通水可能在动员会同年，先后方向待再核",
  "source":"2026-08-01 回访录音 '"$TS"'","editor":"志愿者小李"}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("关系附记 #"+d.erratum.erratumId)'

say "4) 访客读取最新年表：可见两条生效附记；事件 / 关系旁有「勘误」标记"
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("currentVersionNo =", d.currentVersionNo, " 附记数 =", d.version.errata.length);
for (const e of d.version.errata)
  console.log(`  #${e.erratumId} [${e.targetType} #${e.targetId}] ${e.content} —— ${e.source}`);'
curl -s "$BASE/api/public/versions/$V" | jfield '"指定历史版本附记数 = " + d.version.errata.length + "\n"'

say "5) 附记出处沿用精确遮盖规则：登记遮盖后访客见「出处已遮盖」，编辑者仍见原文"
SECRET="秘藏全宗 77 第 1 页 $TS"
post "$BASE/api/editor/versions/$V/errata" -d '{"targetType":"event","targetId":'"$E2"',"content":"出处事后要求遮盖的附记","source":"'"$SECRET"'"}' >/dev/null
post "$BASE/api/editor/redaction" -d '{"source":"'"$SECRET"'","currentVersionNo":'"$(latest_no)"'}' >/dev/null
echo -n "访客视图中该附记出处："
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const t='"$E2"';
const e=d.version.errata.find(x=>x.targetId===t);process.stdout.write(e.source+"\n")'
echo -n "编辑者原文视图中的出处："
get_ed "$BASE/api/editor/versions/$V/raw" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const t='"$E2"';
const e=d.activeErrata.find(x=>x.targetId===t);process.stdout.write(e.source+"\n")'

say "6) 替代：不带所见附记号 → 409 ERRATA_CONFLICT（响应携带当前附记，不落库）"
RESP=$(post -w $'\n%{http_code}' "$BASE/api/editor/versions/$V/errata" -d '{
  "targetType":"event","targetId":'"$E1"',"content":"另一位编辑者的说法","source":"另一份档案"}')
code=$(printf '%s' "$RESP" | tail -1)
printf '%s' "$RESP" | sed '$d' | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("code =", d.code, " 当前附记 =", d.currentErratum ? "#"+d.currentErratum.erratumId+"："+d.currentErratum.content : "无");'
[ "$code" = 409 ] || { echo "FAIL：期望 409，实际 $code"; exit 1; }

say "7) 携所见附记号 $FIRST_ID 正确替代（旧附记保留，访客只见最新生效）"
NEW_ID=$(post "$BASE/api/editor/versions/$V/errata" -d '{
  "targetType":"event","targetId":'"$E1"',
  "content":"再核：动员会为 1958 年 10 月 3 日（取代此前月份级说法）",
  "source":"县档案馆全宗 03 第 13 页","expectedErratumId":'"$FIRST_ID"'}' \
  | jfield 'd.erratum.erratumId')
echo "新生效附记 #$NEW_ID（supersedes #$FIRST_ID）"
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const t='"$E1"';
process.stdout.write("访客可见该目标生效附记 = #"+d.version.errata.find(e=>e.targetId===t&&e.targetType==="event").erratumId+"\n");'

say "8) 替代链：旧附记保留供追溯（编辑者可见原文）"
get_ed "$BASE/api/editor/errata/$NEW_ID/chain" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log(`目标 ${d.target.targetType} #${d.target.targetId}，当前生效 #${d.activeErratumId}，替代链 ${d.chain.length} 条：`);
for (const e of d.chain) console.log(`  #${e.erratumId}${e.erratumId===d.activeErratumId?"（生效）":"（已替代）"} ${e.content} —— ${e.source}`);'

say "9) 两人同时替代（都提交所见号 $NEW_ID）：仅一个 201，另一个 409 且不落库"
pids=()
curl -s -o /tmp/errata-ex-a.json -w 'A:%{http_code}\n' -X POST "${h_json[@]}" "${h_ed[@]}" \
  "$BASE/api/editor/versions/$V/errata" -d '{"targetType":"event","targetId":'"$E1"',"content":"甲终稿","source":"甲","expectedErratumId":'"$NEW_ID"'}' &
pids+=($!)
curl -s -o /tmp/errata-ex-b.json -w 'B:%{http_code}\n' -X POST "${h_json[@]}" "${h_ed[@]}" \
  "$BASE/api/editor/versions/$V/errata" -d '{"targetType":"event","targetId":'"$E1"',"content":"乙终稿","source":"乙","expectedErratumId":'"$NEW_ID"'}' &
pids+=($!)
for p in "${pids[@]}"; do wait "$p"; done
node -e 'const a=require("/tmp/errata-ex-a.json"),b=require("/tmp/errata-ex-b.json");
const ok=a.erratum?a:(b.erratum?b:null), fail=a.erratum?b:a;
console.log("成功者内容 =", ok.erratum.content, " 冲突 code =", fail.code, " 冲突方取得当前附记 =", fail.currentErratum.content);
if (fail.code!=="ERRATA_CONFLICT"||fail.currentErratum.content!==ok.erratum.content) process.exit(1);'
get_ed "$BASE/api/editor/versions/$V/errata" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const t='"$E1"';
process.stdout.write("该目标库中附记总数（含旧）= "+d.errata.filter(e=>e.targetType==="event"&&e.targetId===t).length+"\n");'

say "10) 非法登记全部拒绝"
[ "$(code_of -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/versions/999/errata" -d '{"targetType":"event","targetId":1,"content":"x","source":"y"}')" = 404 ] \
  && echo "版本不存在 → 404" || { echo "FAIL 404"; exit 1; }
[ "$(code_of -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/versions/$V/errata" -d '{"targetType":"event","targetId":99999,"content":"x","source":"y"}')" = 422 ] \
  && echo "对象不属该版 → 422 ERRATA_TARGET_NOT_IN_VERSION" || { echo "FAIL 422"; exit 1; }
[ "$(code_of -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/versions/$V/errata" -d '{"targetType":"claim","targetId":'"$C1"',"content":"x","source":"y"}')" = 400 ] \
  && echo "targetType 非法 → 400" || { echo "FAIL 400"; exit 1; }
[ "$(code_of -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/versions/$V/errata" -d '{"targetType":"event","targetId":'"$E1"',"content":"  ","source":"y"}')" = 400 ] \
  && echo "空说明 → 400" || { echo "FAIL 400"; exit 1; }

say "11) 撤回目标版：拒绝新登记（409 VERSION_RETRACTED），访客不再看到该版及其附记"
post "$BASE/api/editor/versions/$V/retract" -d '{"reason":"编年依据错误，撤回修订","editor":"示例脚本"}' >/dev/null
[ "$(code_of -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/versions/$V/errata" -d '{"targetType":"event","targetId":'"$E1"',"content":"撤回后补记","source":"x","expectedErratumId":1}')" = 409 ] \
  && echo "已撤回版拒绝登记 → 409" || { echo "FAIL 撤回拒绝"; exit 1; }
[ "$(code_of "$BASE/api/public/versions/$V")" = 404 ] && echo "访客读撤回版 → 404（附记随之不可见）" || { echo "FAIL 404"; exit 1; }
echo -n "编辑者仍可查该版旧附记："
get_ed "$BASE/api/editor/versions/$V/errata" | jfield '"retracted=" + d.retracted + "，附记 " + d.errata.length + " 条\n"'

say "12) 修正后发布新版：附记不继承（新版本无附记）"
PUB=$(post "$BASE/api/editor/publish" \
  -d '{"selection":[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'}],"baseVersionNo":'"$V"',"note":"修正编年新版","editor":"示例脚本"}')
V2=$(echo "$PUB" | jfield 'd.versionNo')
echo "新版本号：$V2"
curl -s "$BASE/api/public/chronicle" | jfield '"最新第 " + d.currentVersionNo + " 版附记数 = " + d.version.errata.length + "（第 '"$V"' 版旧附记仍只属该版）\n"'
[ "$V2" = "$((V + 1))" ] && echo "新版本号继续递增（撤回版不占号）：第 $V2 版"

say "全部断言通过 ✅"
echo "提示：$BASE/ 访客页可见「本版勘误附记」卡片；$BASE/editor 「已发布版本」中第 $V 版点「勘误附记」可看原文与替代链。"
