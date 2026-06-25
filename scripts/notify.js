/**
 * Amplitude × Minders — Daily Slack Notifier
 * Runs via GitHub Actions every morning at 9am CDMX (14:00 UTC)
 * Checks which cadence steps are due today and DMs each responsible person
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN; // secret in GitHub repo
const JSONBIN_ID      = process.env.JSONBIN_ID;
const JSONBIN_KEY     = process.env.JSONBIN_KEY;
const DASHBOARD_URL   = process.env.DASHBOARD_URL || 'https://matiasbossie.github.io/amplitude-minders-coreach/';

// ── DATA ────────────────────────────────────────────────────────────────────
const accounts = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/accounts.json'), 'utf8'));
const team     = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/team.json'), 'utf8'));

// ── HELPERS ─────────────────────────────────────────────────────────────────
function today() {
  if (process.env.TEST_DATE) return process.env.TEST_DATE; // override for dry runs
  const d = new Date();
  const offset = -6; // CDMX standard
  const local = new Date(d.getTime() + offset * 60 * 60 * 1000);
  return local.toISOString().split('T')[0];
}

function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ ok: res.statusCode < 300, status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

// ── LOAD CLOUD STATE ────────────────────────────────────────────────────────
async function loadState() {
  if (!JSONBIN_ID || !JSONBIN_KEY) {
    console.log('⚠️  No JSONBin config — running without sent-state check');
    return {};
  }
  const r = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_ID}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_KEY }
  });
  return r.body?.record || {};
}

function isStepSent(state, accId, stepLbl) {
  return state[accId]?.['sent_' + stepLbl] === true;
}

function getStepDate(acc, step, state) {
  // Check if step date was overridden in dashboard
  const ov = state[acc.id]?.['step_' + step.lbl];
  const day = ov?.day ?? step.day;
  const startOverride = state[acc.id]?.startOverride;
  const d1 = startOverride || acc.d1;
  return addDays(d1, day - 1);
}

// ── SLACK ────────────────────────────────────────────────────────────────────
async function sendDM(channelId, blocks) {
  if (!SLACK_BOT_TOKEN) { console.log(`[DRY RUN] Would post to channel ${channelId}`); return; }

  const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: { channel: channelId, blocks, unfurl_links: false }
  });
  if (!msgRes.body?.ok) console.error('Slack error:', msgRes.body?.error);
}

function buildMessage(person, tasks, todayStr) {
  const greeting = `Buenos días, *${person.name}* 👋`;
  const dateFormatted = new Date(todayStr + 'T12:00:00Z').toLocaleDateString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long'
  });

  const taskBlocks = tasks.map(t => ({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `*${t.step} — ${t.account}*`,
        `📋 ${t.action}`,
        t.asset ? `📦 Asset: _${t.asset}_` : '',
        t.angle ? `💡 Ángulo: _${t.angle}_` : '',
      ].filter(Boolean).join('\n')
    }
  }));

  return [
    { type: 'header', text: { type: 'plain_text', text: '📬 Co-Reach Amplitude × Minders' } },
    { type: 'section', text: { type: 'mrkdwn', text: `${greeting}\nHoy es *${dateFormatted}* y tenés ${tasks.length} acción${tasks.length > 1 ? 'es' : ''} pendiente${tasks.length > 1 ? 's' : ''}:` } },
    { type: 'divider' },
    ...taskBlocks.flatMap((b, i) => i < taskBlocks.length - 1 ? [b, { type: 'divider' }] : [b]),
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `<${DASHBOARD_URL}|→ Ver dashboard completo>` }
    }
  ];
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const todayStr = today();
  console.log(`\n🗓  Checking tasks for ${todayStr}\n`);

  const state = await loadState();

  // Collect tasks per person key
  const tasksByPerson = {}; // { "AP": [{account, step, action, asset, angle}] }

  for (const acc of accounts) {
    // Also check custom steps from state
    const customSteps = state[acc.id]?.customSteps || [];
    const allSteps = [...acc.cadence, ...customSteps.map(cs => ({
      lbl: cs.lbl, day: cs.day, owners: ['ae'], action: cs.desc
    }))];

    for (const step of allSteps) {
      const stepDate = getStepDate(acc, step, state);
      if (stepDate !== todayStr) continue;
      if (isStepSent(state, acc.id, step.lbl)) {
        console.log(`  ✓ ${acc.name} ${step.lbl} — already sent, skipping`);
        continue;
      }

      console.log(`  📌 ${acc.name} ${step.lbl} — due today`);

      // Resolve who should get notified
      const ownerKeys = step.owners.map(o => {
        if (o === 'bdr')   return acc.team.bdr;
        if (o === 'ae')    return acc.team.ae;
        if (o === 'rm')    return acc.team.rm;
        if (o === 'ampAe') return acc.team.ampAe;
        return null;
      }).filter(Boolean);

      const uniqueOwners = [...new Set(ownerKeys)];

      for (const key of uniqueOwners) {
        if (!tasksByPerson[key]) tasksByPerson[key] = [];
        tasksByPerson[key].push({
          account: acc.name,
          step: step.lbl,
          action: step.action,
          asset: acc.asset,
          angle: step.lbl === 'D1' ? acc.d1_angle : null,
        });
      }
    }
  }

  // Send messages
  const personKeys = Object.keys(tasksByPerson);
  if (personKeys.length === 0) {
    console.log('\n✅ No tasks due today.\n');
    return;
  }

  console.log(`\n📤 Sending ${personKeys.length} Slack DM(s)...\n`);

  for (const key of personKeys) {
    const person = team[key];
    if (!person) { console.warn(`Unknown team key: ${key}`); continue; }

    const tasks = tasksByPerson[key];
    console.log(`  → ${person.name} (${key}): ${tasks.length} task(s)`);

    if (!person.slack_channel_id) {
      console.warn(`    ⚠️  No slack_channel_id for ${person.name} — add it to config/team.json`);
      continue;
    }

    const blocks = buildMessage(person, tasks, todayStr);
    await sendDM(person.slack_channel_id, blocks);
    console.log(`    ✅ DM sent`);
  }

  console.log('\n🏁 Done.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
