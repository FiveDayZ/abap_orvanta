<p align="center">
  <img src="ui/icons/orvanta-favicon.svg" alt="ORVANTA logo" width="112" height="112" />
</p>

# ORVANTA

ORVANTA is a standalone Model Context Protocol (MCP) service for SAP ABAP Development Tools. It exposes controlled ABAP discovery, source, repository, DDIC, diagnostics, transport inspection, RFC, and customer-object lifecycle tools to MCP clients.

Current source version: `0.41.1`.

## 0.41.1

- Resolves classic Include activation through an unambiguous main-program context returned by SAP.
- Treats malformed, unavailable, or ambiguous inactive-source observations as blockers instead of absence.
- Preserves save, unlock, activation, active-source, and inactive-source evidence when activation fails. A saved replacement is not submitted again automatically.
- Verifies successful source replacement and activate-only recovery by reading back the active source.
- Includes the DDIC helper 1.7 table-component, technical-setting, and native conversion-recovery additions prepared in 0.41.0.

Local build and static checks do not establish SAP runtime acceptance. Review the release notes before deploying helpers or using state-changing tools.

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

The generated package is written under `release/` as `orvanta-mcp-<version>-win-x64.zip`, which is intentionally excluded from source control. GitHub Release titles use `orvanta-mcp-<version>`.

Starting with `0.40.4`, the self-contained package includes `update.cmd`. Stop the MCP service and close the local settings UI, then double-click `update.cmd` to install the latest stable Windows x64 release. The updater verifies the release SHA-256, version, platform, ZIP paths, and packaged file manifest before replacing program files. It preserves `connections.json`, `exports`, and the external state directory, and restores the previous program files if replacement fails.

The updater does not install or upgrade SAP helpers, change SAP objects or business data, or release transports. GitHub Release checksums verify download integrity; they are not publisher signatures. Packages older than `0.40.4` require one manual upgrade before this entry is available.

Source-checkout users should stop ORVANTA, update the checkout with Git, then run `npm ci` and `npm run build`; `update.cmd` is only for the self-contained Windows package.

## SAP Helpers

Some legacy-ECC and structured repository operations require customer-namespace SAP helper objects. The installer source is in `scripts/bootstrap-sap-helper.ps1`; SMARTFORMS helper sources are in `scripts/smartforms/`.

Installing or upgrading helpers changes SAP repository objects. Review the target object names, package, transport, permissions, and source before executing any helper action. ORVANTA does not release transports automatically.

## Agent Skills

The latest companion Skill bundle is available at [`skills/orvanta-skills-0.1.2.zip`](skills/orvanta-skills-0.1.2.zip). It contains two independent Skills:

- `abap-mcp-development` for explicitly authorized ABAP customer-object development
- `abap-mcp-review` for read-only ABAP review and diagnosis

Extract the archive, then install the required directory from its `skills/` folder using the target Agent client's Skill mechanism. Each installed Skill directory must retain its `SKILL.md` and `references/` content.

Bundle SHA-256:

```text
8B807B7EED4ABE81119EE67B6619525D0A3373D2577606915007A3EBC35C3B38
```

The bundle is version `0.1.2` and is marked `Partially Verified` in its own documentation. It adds guidance for useful, truthful ABAP code comments while retaining the seven-Include classic Program convention from 0.1.1. Its static tool-routing baseline remains ORVANTA `0.40.1`; live tool discovery takes precedence when it is used with `0.41.1`. Client discovery, automatic triggering, behavior, and cross-platform installation still require validation in each target Agent environment.

## Safety Boundaries

- Credentials and local connection files are excluded from Git.
- Read permissions do not imply write permissions.
- Customer-object write tools require explicit inputs and safety checks.
- Runtime support depends on the target SAP release, enabled ADT services, installed helpers, authorization, and object state.
- Activation, diagnostics, or tool registration alone do not prove a business process is correct.

## License

MIT
