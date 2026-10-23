# A2A digital twin: Mist + Central

ทีม AI agent สามตัวที่คุยกันผ่าน A2A เพื่อตอบคำถามเกี่ยวกับเครือข่ายที่อยู่คนละระบบ (Juniper Mist และ Aruba Central) พร้อมหน้า dashboard แบบสด

```
คุณ ──► Dashboard (SSE) ──► Orchestrator ──A2A──► Mist agent    ──MCP──► Mist MCP server (remote)
                                          └─A2A──► Central agent ──MCP──► Central MCP server (remote)
```

- **Orchestrator** รับคำถาม ให้โมเดลเลือกว่าต้องถาม agent ตัวไหน ส่งงานแบบขนาน รอผล แล้วรวมเป็น report เดียว
- **Domain agent** (Mist, Central) เป็น A2A server ตามสเปก v1.0 แต่ละตัวให้โมเดลเรียก tool ของ MCP server ฝั่งตัวเอง
- **Dashboard** แสดงสถานะจริงที่ stream มาจาก A2A (`submitted`, `working`, `completed`, `failed`...) และการเรียก tool ของแต่ละ agent

## เลือกวิธีเรียกโมเดล (`ENGINE`)

| | `agent-sdk` (ค่าเริ่มต้นถ้าไม่มี API key) | `api` |
|---|---|---|
| ใช้อะไร | Claude Code (ผ่าน Agent SDK) ที่ login ด้วยแผน Pro/Max ของคุณ | `ANTHROPIC_API_KEY` จาก Claude Console |
| ค่าใช้จ่าย | กินโควตาของแผนสมาชิก ไม่ต้องมี API credit | คิดเงินตามการใช้ API แยกจากแผนสมาชิก |
| ใช้กับใคร | **เครื่องของคุณเอง คนเดียว** (โปรแกรมไม่ยอมเปิดให้เครื่องอื่นเข้า) | แชร์ให้ทีมได้ (ตั้ง `HOST` และ `DASHBOARD_PASSWORD`) |

เหตุผลที่ `agent-sdk` จำกัดให้ใช้บนเครื่องตัวเอง: Anthropic ระบุไว้ใน [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) ว่าโควตาของ Pro/Max คิดไว้สำหรับการใช้งานรายบุคคล และห้ามส่งคำขอของผู้ใช้คนอื่นผ่าน credential ของแผน ถ้าเพื่อนร่วมทีมอยากใช้ ให้แต่ละคนรันสำเนาของตัวเองด้วย login ของตัวเอง หรือใช้ `ENGINE=api`

## เริ่มเร็ว (ไม่ต้องมี key และไม่ต้อง login)

```bash
npm install
npm run mock        # เปิด http://127.0.0.1:3000
```

โหมด `MOCK=1` ใช้ข้อมูลจำลองทั้งหมด แต่ท่อจริงทำงานครบ: A2A ผ่าน HTTP, event stream, report ใส่ `FAIL_MIST` หรือ `FAIL_CENTRAL` ในคำถามเพื่อดูกรณี agent ล้มเหลว

## ใช้กับระบบจริงด้วยแผน Pro (ไม่ต้องมี API key)

**1. login Claude Code ด้วยบัญชี claude.ai ของคุณ (ทำครั้งเดียว)**

ติดตั้ง Claude Code ตาม [คู่มือ](https://code.claude.com/docs/en/setup) แล้วพิมพ์ `claude` ใน terminal ทำตามขั้นตอน login ด้วยบัญชีที่ซื้อแผน Pro ไว้ (แอปนี้ใช้ Claude Code ที่ติดมากับ Agent SDK ตัวที่ login เดียวกัน)

ถ้า login แบบนี้ใช้ไม่ได้ (เช่น รันบนเครื่องที่ไม่มีเบราว์เซอร์) ให้รัน `claude setup-token` แล้วใส่ token ที่ได้ใน `.env` เป็น `CLAUDE_CODE_OAUTH_TOKEN=...` ([เอกสาร](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token))

**2. ตั้งค่า MCP**

```bash
cp .env.example .env
```

แต่ละแพลตฟอร์มเลือกได้สองแบบ (ไม่ต้องใส่ `ANTHROPIC_API_KEY` ถ้ามีอยู่ในเครื่อง โปรแกรมจะไม่ส่งให้ Claude Code เพื่อให้ใช้โควตาแผนแน่ๆ):

- **remote** (Streamable HTTP หรือ SSE ลองให้อัตโนมัติ): `*_MCP_URL`, `*_MCP_TOKEN` (ส่งเป็น `Authorization: Bearer`), `*_MCP_HEADERS` สำหรับ header อื่น เป็นคู่ `ชื่อ:ค่า` คั่นด้วย `;`
- **local stdio** (โปรแกรมที่รันในเครื่อง เช่น `uvx`, `npx`): `*_MCP_COMMAND`, `*_MCP_ARGS` (คั่นด้วยเว้นวรรค), `*_MCP_ENV` เป็นคู่ `ชื่อ=ค่า` คั่นด้วย `;`

ตัวอย่าง ถ้าเดิมคุณตั้งใน Claude Desktop แบบนี้:

```json
"central-dxp-mcp": { "command": "uvx", "args": ["--prerelease=allow", "--with", "mcp<2", "central-mcp-server"],
                     "env": { "CENTRAL_BASE_URL": "...", "CENTRAL_CLIENT_ID": "...", "CENTRAL_CLIENT_SECRET": "..." } },
"mist-dxp-cloud":   { "command": "npx", "args": ["mcp-remote", "https://mcp.ai.juniper.net/mcp/mist",
                      "--header", "Authorization:Bearer <token>", "--header", "X-Mist-Base-URL:https://api.mist.com"] }
```

ใน `.env` เขียนเป็น (`mcp-remote` เป็นแค่ตัวต่อของ client ที่คุยได้เฉพาะ stdio แอปนี้ต่อ URL ตรงๆ ได้เลย):

```
MIST_MCP_URL=https://mcp.ai.juniper.net/mcp/mist
MIST_MCP_TOKEN=<token>
MIST_MCP_HEADERS=X-Mist-Base-URL:https://api.mist.com

CENTRAL_MCP_COMMAND=uvx
CENTRAL_MCP_ARGS=--prerelease=allow --with mcp<2 central-mcp-server
CENTRAL_MCP_ENV=CENTRAL_BASE_URL=https://us5.api.central.arubanetworks.com/;CENTRAL_CLIENT_ID=<id>;CENTRAL_CLIENT_SECRET=<secret>
```

ยังไม่รองรับ MCP ที่ใช้ OAuth ในตัว (ต้องมี token หรือ client credentials ตายตัว) และไฟล์ `.env` เก็บความลับ อย่าส่งต่อหรือ commit ลง git

**3. ตรวจก่อนเริ่ม**

```bash
npm run check
```

คำสั่งนี้ส่งคำขอเล็กๆ หนึ่งครั้งไปที่ Claude Code แล้วบอกว่า login เป็นใครและแผนอะไร (ควรเห็น `signed in with your Claude plan: pro`) จากนั้นต่อ MCP แต่ละฝั่งและแสดงรายชื่อ tool ที่ agent ใช้ได้กับที่ถูกบล็อก **อ่านรายชื่อที่ถูกบล็อกให้ครบก่อนใช้งานจริง** ถ้า tool ที่แก้ค่าได้หลุดมาอยู่ฝั่งที่ใช้ได้ ให้ปรับ `MIST_TOOL_ALLOW` / `CENTRAL_TOOL_ALLOW`

**4. เริ่ม**

```bash
npm run build && npm start   # เปิด http://127.0.0.1:3000 (อ่าน .env ให้เอง)
```

### เรื่องโควตา

หนึ่งคำถามเรียก Claude Code อย่างน้อย 4 ครั้ง (วางแผน, agent สองตัวที่วนเรียก tool, รวมผล) กินโควตา Pro มากกว่าแชตธรรมดา ถ้าโควตาหมดเร็ว ลด `MAX_TOOL_CALLS`, ถามให้แคบลง หรือลองตั้ง `MODEL` เป็นโมเดลที่เล็กลง ถ้าชนขีดจำกัด dashboard จะแจ้งว่า agent ล้มเหลวพร้อมสาเหตุ และ report ยังออกจากฝั่งที่สำเร็จ

## ใช้ API key แทน (แชร์ให้ทีมได้)

```bash
ENGINE=api
ANTHROPIC_API_KEY=...        # ใน .env
```

```bash
docker build -t a2a-twin .
docker run -p 3000:3000 --env-file .env -e DASHBOARD_PASSWORD=รหัสผ่านของทีม a2a-twin
```

วางหลัง HTTPS (reverse proxy) แล้วส่ง URL กับรหัสผ่านให้ทีม เมื่อรันคำถาม URL จะมี `#run=...` ต่อท้าย ส่งลิงก์นั้นให้เพื่อนเพื่อ replay การทำงานและ report เดิมได้ ถ้า reverse proxy เปิด buffering ให้ปิดสำหรับ `/api/runs/*/events` (เซิร์ฟเวอร์ส่ง `X-Accel-Buffering: no` ให้แล้ว)

ถ้าใช้ `agent-sdk` บนเครื่องตัวเอง ลิงก์ `#run=` เปิดได้เฉพาะบนเครื่องคุณ ให้ส่งผลให้ทีมด้วยปุ่ม "คัดลอกเป็น Markdown" ในหน้า report แทน

## ความปลอดภัยที่ออกแบบไว้

| เรื่อง | ทำอย่างไร |
|---|---|
| agent แก้ค่าอุปกรณ์ไม่ได้ | เปิดให้โมเดลเห็นเฉพาะ tool ที่ชื่อมี `get_`, `list_`, `search_`, `find_` และตรวจซ้ำตอนเรียกจริง tool อย่าง `bounce_port`, `create_*`, `run_show_commands` ถูกตัดทิ้งโดยปริยาย ปรับด้วย `MIST_TOOL_ALLOW` / `CENTRAL_TOOL_ALLOW` ถ้าแน่ใจ |
| Claude Code ทำอย่างอื่นนอกจากเรียก tool | โหมด `agent-sdk` ปิด tool ในตัวทั้งหมด (ไม่มี Bash, ไม่มีอ่าน/เขียนไฟล์, ไม่มีเว็บ), ใช้เฉพาะ MCP server ที่เรากำหนด (ไม่โหลด connector อื่นของคุณ), ไม่อ่าน settings/CLAUDE.md/skills ของคุณ, ไม่เก็บ transcript, ทำงานในโฟลเดอร์ว่าง และมี hook ตรวจ allowlist กับงบ tool call ซ้ำทุกครั้งที่เรียก |
| ข้อมูลจากเครือข่ายพยายามสั่งโมเดล | system prompt บอกว่าผลของ tool เป็นข้อมูล ไม่ใช่คำสั่ง และ tool ที่เสี่ยงถูกตัดออกอยู่แล้ว |
| dashboard เปิดสู่สาธารณะโดยไม่ตั้งรหัส | ถ้า `HOST` ไม่ใช่ loopback แต่ไม่มี `DASHBOARD_PASSWORD` โปรแกรมไม่ยอมเริ่ม |
| login แผนสมาชิกถูกเอาไปให้คนอื่นใช้ | `ENGINE=agent-sdk` ไม่ยอมเปิดบน `HOST` ที่ไม่ใช่ loopback |
| XSS จากชื่ออุปกรณ์หรือ client | หน้า dashboard สร้างทุกอย่างด้วย `textContent` ไม่มี `innerHTML` และมี CSP |
| ค่าใช้จ่ายบานปลาย | จำกัดจำนวน tool call ต่อ agent (`MAX_TOOL_CALLS`), timeout ต่อ agent (ตัด Claude Code ทิ้งเมื่อหมดเวลา), และจำนวนคำถามที่รันพร้อมกัน |
| ย้อนดูว่าตัวเลขมาจากไหน | report แนบรายการ tool ทุกครั้งที่เรียก รวมถึงครั้งที่ถูกบล็อก |

## ข้อจำกัดที่ควรรู้

- **ทดสอบกับของปลอมเท่านั้น**: ชุดทดสอบใช้ MCP server ปลอมและ Anthropic API ปลอมในเครื่อง โหมด `agent-sdk` ทดสอบกับ Claude Code ตัวจริงที่ติดมากับ SDK แต่ใช้ token ปลอม ยังไม่เคยรันกับ login Pro จริง, Mist/Central MCP จริง หรือโมเดลจริงครบทั้งสายงาน ให้รัน `npm run check` แล้วลองกับไซต์ทดสอบก่อนใช้งานจริง
- นโยบายของ Anthropic เรื่องการใช้ Agent SDK กับแผนสมาชิกเปลี่ยนมาแล้วหนึ่งรอบ ([บทความล่าสุด](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)) ถ้าวันหนึ่งไม่คิดเข้าโควตาแผนแล้ว ให้สลับไป `ENGINE=api`
- endpoint A2A ของ agent **ไม่มี authentication** จึงฟังที่ `127.0.0.1` ภายในโปรเซสเดียวกัน ถ้าแยก agent ไปเครื่องอื่น (`START_AGENTS=0`) ให้อยู่ใน private network
- ประวัติการรัน (สำหรับ replay และลิงก์แชร์) เก็บในหน่วยความจำ รีสตาร์ทแล้วหาย เก็บสูงสุด 50 รัน
- การเลือก tool แบบ read-only ใช้ชื่อเป็นเกณฑ์ MCP server ที่ตั้งชื่อ tool ผิดแบบ (เช่น `get_` ที่แก้ค่าได้) จะหลุดได้ ตรวจรายชื่อด้วย `npm run check`
- รหัสผ่านเป็นแบบร่วมกันทั้งทีม ไม่มีบัญชีผู้ใช้หรือ log ว่าใครถามอะไร

## แก้ปัญหา

| อาการ | ทำอะไร |
|---|---|
| `check` บอกว่า login ไม่ได้ / agent ล้มเหลวด้วยข้อความเรื่อง login | `claude` แล้ว `/login` ใหม่ หรือใช้ `claude setup-token` |
| `check` เตือนว่า credential source ไม่ใช่ none | มี API key หรือ provider อื่นตั้งไว้ในเครื่อง ตรวจตัวแปร `ANTHROPIC_*` และ `CLAUDE_CODE_USE_*` |
| `ต่อ MCP server ไม่ได้ (สถานะ: ...)` | ตรวจ URL/คำสั่ง, token, header ด้วย `npm run check`; ถ้า MCP แบบ stdio เริ่มช้า (ครั้งแรกของ `uvx` ต้องโหลดแพ็กเกจ) ให้รัน `npm run check` ก่อนหนึ่งรอบเพื่ออุ่น cache และตั้ง `MCP_TIMEOUT=30000` ใน `.env` |
| ดูสิ่งที่ Claude Code พิมพ์ออกมา | ตั้ง `DEBUG_SDK=1` |

## โครงสร้าง

```
src/start.ts             จุดเริ่ม: ตรวจ config, เปิด agent, เปิดเว็บ
src/check.ts             npm run check: ตรวจ login และ MCP ก่อนใช้งาน
src/domain-agent.ts      A2A server + loop โมเดล (ใช้ซ้ำทั้ง Mist และ Central)
src/agent-sdk-engine.ts  เรียกโมเดลผ่าน Claude Code / Agent SDK ด้วย login แผนสมาชิก
src/orchestrator.ts      A2A client: วางแผน, ส่งงานขนาน, รวมผล
src/mcp.ts               ต่อ remote MCP, กรอง tool แบบ read-only
src/hub.ts               เก็บ event ต่อรัน, replay ให้คนที่เข้ามาทีหลัง
src/server.ts            Express: รหัสผ่าน, /api/ask, SSE
src/mock.ts              ข้อมูลจำลอง
public/index.html        หน้า dashboard
test/                    ชุดทดสอบ e2e พร้อม MCP (HTTP และ stdio) และ Anthropic API ปลอม
```

## ทดสอบ

```bash
npm test            # mock + real (api) + sdk (Claude Code ตัวจริง) ทั้งหมดกับของปลอมในเครื่อง
npm run typecheck
```

ชุดทดสอบ `sdk` ยืนยันว่า: ใช้ token ของแผนไม่ใช่ API key (ใส่ key หลอกไว้แล้วต้องไม่ถูกส่ง), tool อันตรายไม่ถูกเสนอให้โมเดลและไม่ถึง MCP server, งบ tool call คุมอยู่แม้โมเดลยิง 10 คำสั่งพร้อมกัน

## เพิ่มเติมที่ทำต่อได้

- แยก agent เป็นบริการของตัวเอง (`START_AGENTS=0`, `*_AGENT_URL`) เมื่อต้องการให้คนละทีมดูแล
- เก็บประวัติรันลงฐานข้อมูล (SDK มี `DatabaseTaskStore` สำหรับฝั่ง agent)
- เพิ่ม agent ตัวที่สาม (เช่น AOS8) โดยเพิ่ม domain ใน `config.ts` และตัวละครในหน้า dashboard
