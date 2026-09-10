# Working on Tek plugins

Read README.md and `../tek/docs/engineering/WORKFLOW.md`. Preserve existing edits.
Source plugins live in plugins/; built-ins are maintained in the Gateway repo.
Keep plugin, package, extension and registry versions synchronized. Run the
registry verifier and affected plugin tests before commit; inspect packaged
entry points and extension assets. Use Node 22+ and the existing npm commands.

Browser origins, connection ownership and user grants are security boundaries.
Test stale connections, malformed targets and revocation before release. Keep
comments in plain English. Retain only current build artifacts, preserving
configuration, credentials, transcripts and user-created files.
