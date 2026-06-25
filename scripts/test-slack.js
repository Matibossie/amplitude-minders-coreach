const https = require('https');

const TOKEN   = process.env.SLACK_BOT_TOKEN;
const USER_ID = process.env.SLACK_USER_ID; // Member ID del usuario (U0XXXXXXX)

function slackApi(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'slack.com',
      path: `/api/${path}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      }
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  // Abrir DM entre el bot y el usuario
  console.log(`Opening DM with user ${USER_ID}...`);
  const dm = await slackApi('conversations.open', { users: USER_ID });
  if (!dm.ok) { console.error('❌ Error abriendo DM:', dm.error); return; }
  const channel = dm.channel.id;
  console.log(`DM channel: ${channel}`);

  console.log('Sending test message...');
  const res = await slackApi('chat.postMessage', {
    channel,
    channel,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '📬 Co-Reach Amplitude × Minders' } },
      { type: 'section', text: { type: 'mrkdwn', text: `Buenas, *Mati* 👋\nEste es un mensaje de prueba del sistema de alertas.\n\nEl bot está funcionando correctamente ✅` } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*Ejemplo — D1 · Santander México*\n📋 Solicitud de conexión LI con nota personalizada (máx 300 chars). Trigger específico de la empresa, no de Minders.\n💡 Ángulo: Activación digital — brecha entre usuarios registrados y activos antes de que el hábito del banco físico regrese.\n📦 Asset: Fintech Engagement Playbook` } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '<https://matiasbossie.github.io/amplitude-minders-coreach/|→ Ver dashboard completo>' } }
    ]
  });

  if (res.ok) {
    console.log('✅ Mensaje enviado correctamente a', channel);
    console.log(`   → Guardá este channel ID para config/team.json: ${channel}`);
  } else {
    console.error('❌ Error:', res.error);
  }
}

main().catch(console.error);
