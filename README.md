# ORVANTA

ORVANTA is a standalone Model Context Protocol (MCP) service for SAP ABAP Development Tools. It runs without VS Code and exposes controlled ABAP discovery, source, repository, DDIC, diagnostics, transport inspection, RFC, and customer-object lifecycle tools to MCP clients.

Current source version: `0.40.1`.

## Requirements

- Node.js 24 or later
- An SAP system with ADT HTTP services enabled
- A SAP user with the permissions required for each requested operation

## Install

```powershell
git clone https://github.com/FiveDayZ/abap_orvanta.git
cd abap_orvanta
npm ci
Copy-Item connections.example.json connections.json
```

Edit `connections.json` for your SAP system. Keep passwords out of this file and provide each password through the environment variable named by `passwordEnv`.

```powershell
$env:ABAP_MCP_CONFIG = "$PWD\connections.json"
$env:ABAP_MCP_PORT = "4847"
npm run build
npm start
```

The MCP endpoint is `http://127.0.0.1:4847/mcp`. The health endpoint is `http://127.0.0.1:4847/health`.

## Local Settings UI

After building, start the local configuration UI with:

```powershell
npm run settings
```

The UI binds to loopback only. Session passwords are held in process memory and are not written to the connection file or browser storage.

## Windows Package

PowerShell 7 can build a self-contained Windows x64 package with:

```powershell
npm run package:windows
```

The generated package is written under `release/`, which is intentionally excluded from source control.

## SAP Helpers

Some legacy-ECC and structured repository operations require customer-namespace SAP helper objects. The installer source is in `scripts/bootstrap-sap-helper.ps1`; SMARTFORMS helper sources are in `scripts/smartforms/`.

Installing or upgrading helpers changes SAP repository objects. Review the target object names, package, transport, permissions, and source before executing any helper action. ORVANTA does not release transports automatically.

## Agent Skills

The companion Skill bundle is available at [`skills/orvanta-skills-0.1.0.zip`](skills/orvanta-skills-0.1.0.zip). It contains two independent Skills:

- `abap-mcp-development` for explicitly authorized ABAP customer-object development
- `abap-mcp-review` for read-only ABAP review and diagnosis

Extract the archive, then install the required directory from its `skills/` folder using the target Agent client's Skill mechanism. Each installed Skill directory must retain its `SKILL.md` and `references/` content.

Bundle SHA-256:

```text
B49001C505BAFF3A4FC688EB87027CD3B8F843E9274317EB698CD094CF8ACE6D
```

The bundle is version `0.1.0` and is marked `Partially Verified` in its own documentation. Its client discovery, automatic triggering, behavior, and cross-platform installation still require validation in each target Agent environment.

## Safety Boundaries

- Credentials and local connection files are excluded from Git.
- Read permissions do not imply write permissions.
- Customer-object write tools require explicit inputs and safety checks.
- Runtime support depends on the target SAP release, enabled ADT services, installed helpers, authorization, and object state.
- Activation, diagnostics, or tool registration alone do not prove a business process is correct.

## License

MIT
