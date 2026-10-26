import { CopyField } from './ui';

const KEY_PLACEHOLDER = '<your API key>';

/** How to point an MCP client at the gateway with nothing but its URL and an API key. */
export function ConnectPage() {
  const endpoint = `${window.location.origin}/mcp`;
  const cursorConfig = JSON.stringify(
    {
      mcpServers: {
        'team-gateway': { url: endpoint, headers: { Authorization: `Bearer ${KEY_PLACEHOLDER}` } },
      },
    },
    null,
    2,
  );

  return (
    <>
      <p>
        The gateway has one MCP endpoint (Streamable HTTP). It lists the tools of every enabled server and
        routes each call to the right one. Create a key on the API keys page and put it where{' '}
        {KEY_PLACEHOLDER} is.
      </p>
      <CopyField label="MCP endpoint" value={endpoint} />

      <h2>Claude Code</h2>
      <CopyField
        label="Claude Code command"
        value={`claude mcp add --transport http team-gateway ${endpoint} --header "Authorization: Bearer ${KEY_PLACEHOLDER}"`}
      />

      <h2>Cursor</h2>
      <p className="muted">
        Add this to <code>.cursor/mcp.json</code> in a project, or <code>~/.cursor/mcp.json</code> for every
        project.
      </p>
      <CopyField label="Cursor configuration" value={cursorConfig} />

      <h2>Many tools</h2>
      <p className="muted">
        With many servers, a client can use the search endpoint instead. It lists only two tools:{' '}
        <code>search_tools</code> finds tools by keyword and <code>call_tool</code> runs one by name, with the
        same permissions and audit log.
      </p>
      <CopyField label="Search endpoint" value={`${endpoint}/search`} />

      <h2>MCP Inspector</h2>
      <p className="muted">Lists the tools from a terminal, with the Inspector&apos;s command-line mode:</p>
      <CopyField
        label="MCP Inspector command"
        value={`npx @modelcontextprotocol/inspector@2.12.0 --cli ${endpoint} --transport http --header "Authorization: Bearer ${KEY_PLACEHOLDER}" --method tools/list`}
      />
    </>
  );
}
