// ============================================================
// KONDEI BOT SERVER — Render.com deployment
// No database needed — syncs with the web app
// ============================================================
const express = require('express');
const fetch   = require('node-fetch');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---- In-memory order store ----
let orders = [];

// ---- Config from environment variables ----
const BOT_TOKEN = process.env.BOT_TOKEN || '';

const CHATS = {}; // { brigadeNum: chatId }
const NAMES = {}; // { brigadeNum: name }

(process.env.CHATS || '').split(',').forEach(p => {
  const [b, c] = p.split(':');
  if (b && c) CHATS[b.trim()] = c.trim();
});
(process.env.NAMES || '').split(',').forEach(p => {
  const idx = p.indexOf(':');
  if (idx > 0) NAMES[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
});

// ---- Helpers ----
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method, body) {
  try {
    const res = await fetch(`${TG}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.json();
  } catch (e) {
    console.error(`tg/${method}:`, e.message);
    return {};
  }
}

function getBrigadeName(num) {
  return NAMES[String(num)] || `Бригада ${num}`;
}
function getBrigadeNum(chatId) {
  return Object.entries(CHATS).find(([, c]) => String(c) === String(chatId))?.[0];
}

function buildCalendarKeyboard(orderId, year, month) {
  const monthNames = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow    = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const today       = new Date(); today.setHours(0,0,0,0);
  const prevY = month === 1 ? year-1 : year, prevM = month === 1 ? 12 : month-1;
  const nextY = month === 12 ? year+1 : year, nextM = month === 12 ? 1 : month+1;
  const rows = [
    [{ text:'◀', callback_data:`appt_cal:${orderId}:${prevY}:${prevM}` },
     { text:`${monthNames[month-1]} ${year}`, callback_data:'noop' },
     { text:'▶', callback_data:`appt_cal:${orderId}:${nextY}:${nextM}` }],
    ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => ({ text: d, callback_data: 'noop' }))
  ];
  let week = [];
  for (let i = 0; i < firstDow; i++) week.push({ text:' ', callback_data:'noop' });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso  = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const past = new Date(year, month-1, d) < today;
    week.push({ text: past ? `·${d}` : String(d), callback_data: past ? 'noop' : `appt_d:${orderId}:${iso}` });
    if (week.length === 7) { rows.push(week); week = []; }
  }
  if (week.length) rows.push(week);
  return rows;
}

// ---- REST API for the web app ----

// GET all orders
app.get('/api/orders', (req, res) => res.json(orders));

// POST — web app pushes full list of orders (upsert)
app.post('/api/orders', (req, res) => {
  const incoming = req.body;
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Expected array' });
  // Merge: keep bot-side status/date/time changes, accept new & edited orders from web
  const botMap = Object.fromEntries(orders.map(o => [o.id, o]));
  const result = {};
  incoming.forEach(o => {
    const bot = botMap[o.id];
    result[o.id] = bot
      ? { ...o, status: bot.status, date: bot.date, time: bot.time, brigade: bot.brigade, doneAt: bot.doneAt }
      : o;
  });
  // Keep bot-side-only orders (shouldn't happen normally)
  orders.forEach(o => { if (!result[o.id]) result[o.id] = o; });
  orders = Object.values(result);
  res.json({ ok: true, count: orders.length });
});

// PATCH single order
app.patch('/api/orders/:id', (req, res) => {
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  orders[idx] = { ...orders[idx], ...req.body };
  res.json(orders[idx]);
});

// Health check — keep-alive ping from UptimeRobot
app.get('/', (req, res) => res.send('🤖 Kondei Bot — running ✅'));

// ---- Telegram Polling ----
let lastUpdateId = 0;

async function poll() {
  if (!BOT_TOKEN) return;
  try {
    const data = await (await fetch(`${TG}/getUpdates?offset=${lastUpdateId+1}&timeout=3`)).json();
    if (!data.ok || !data.result?.length) return;

    for (const upd of data.result) {
      lastUpdateId = Math.max(lastUpdateId, upd.update_id);

      if (upd.callback_query) {
        const cq         = upd.callback_query;
        const cb         = cq.data || '';
        const chatId     = String(cq.message.chat.id);
        const brigadeNum = getBrigadeNum(chatId);

        if (cb === 'noop' || cb === 'ack') {
          await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '' });
          continue;
        }

        // Открыть заявку
        if (cb.startsWith('my_order:')) {
          const o = orders.find(x => x.id === cb.slice(9));
          await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '' });
          if (o) {
            const [y,m,d] = (o.date||'--').split('-');
            const dateLabel = o.date ? `${d}.${m}.${y}` : 'не указана';
            const payIcon   = o.payment==='cash' ? '💵 ОПЛАТА НА МЕСТЕ' : o.payment==='paid' ? '✅ Оплачено' : '❓ Оплата не указана';
            const sL = { new:'Новая', scheduled:'Назначена', done:'Выполнена', moved:'Перенесена', refused:'Отказ' };
            const text = [`📋 *Заявка ${o.marker||'—'}*`,'',`👤 *${o.name}*`,
              o.phone?`📞 ${o.phone}`:'', o.city?`📍 ${o.city}`:'', `🏠 ${o.address}`,
              `📦 Кол-во: ${o.count||'—'}`, `💳 ${payIcon}`, `📅 Дата: ${dateLabel}`,
              o.time?`🕐 Время: ${o.time}`:'', `🔖 Статус: ${sL[o.status]||o.status}`,
              o.comment?`💬 ${o.comment}`:''].filter(Boolean).join('\n');
            await tg('sendMessage', { chat_id:chatId, text, parse_mode:'Markdown',
              reply_markup:{ inline_keyboard:[
                [{ text:'✅ Выполнена', callback_data:`done:${o.id}` },{ text:'❌ Отказ', callback_data:`refused:${o.id}` }],
                [{ text: o.date?`📅 ${dateLabel} в ${o.time||'?'}`:'📅 Назначить дату/время', callback_data:`appoint:${o.id}` }]
              ]}
            });
          }
          continue;
        }

        // Календарь
        if (cb.startsWith('appoint:') || cb.startsWith('appt_cal:')) {
          let orderId, year, month;
          if (cb.startsWith('appt_cal:')) {
            const p = cb.split(':'); orderId=p[1]; year=+p[2]; month=+p[3];
          } else {
            orderId = cb.slice(8);
            const now = new Date(); year=now.getFullYear(); month=now.getMonth()+1;
          }
          await tg('answerCallbackQuery', { callback_query_id: cq.id, text:'' });
          await tg('editMessageReplyMarkup', { chat_id:chatId, message_id:cq.message.message_id,
            reply_markup:{ inline_keyboard: buildCalendarKeyboard(orderId, year, month) }
          });
          continue;
        }

        // Выбрана дата — сетка времени
        if (cb.startsWith('appt_d:')) {
          const [,orderId,dateISO] = cb.split(':');
          await tg('answerCallbackQuery', { callback_query_id:cq.id, text:'Выберите время' });
          const times = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00'];
          const busy  = new Set(orders.filter(o=>o.id!==orderId&&o.brigade==brigadeNum&&o.date===dateISO&&!['done','refused'].includes(o.status)&&o.time).map(o=>o.time));
          const rows  = [];
          for (let i=0;i<times.length;i+=4)
            rows.push(times.slice(i,i+4).map(t=>busy.has(t)?{text:`🔴 ${t}`,callback_data:'noop'}:{text:t,callback_data:`appt_t:${orderId}:${dateISO}:${t}`}));
          await tg('editMessageReplyMarkup', { chat_id:chatId, message_id:cq.message.message_id, reply_markup:{ inline_keyboard:rows } });
          continue;
        }

        // Выбрано время
        if (cb.startsWith('appt_t:')) {
          const parts   = cb.split(':');
          const orderId = parts[1], dateISO=parts[2], timeStr=parts[3]+':'+parts[4];
          const order   = orders.find(o=>o.id===orderId);
          const conflict= brigadeNum&&orders.find(o=>o.id!==orderId&&o.brigade==brigadeNum&&o.date===dateISO&&o.time===timeStr&&!['done','refused'].includes(o.status));
          if (conflict) {
            await tg('answerCallbackQuery',{ callback_query_id:cq.id,
              text:`⛔ На ${dateISO.split('-').reverse().join('.')} в ${timeStr} уже занято (${conflict.marker||conflict.name}).`, show_alert:true });
            continue;
          }
          await tg('answerCallbackQuery',{ callback_query_id:cq.id, text:`✅ Назначено: ${dateISO.split('-').reverse().join('.')} в ${timeStr}`, show_alert:true });
          if (order) {
            const idx = orders.findIndex(o=>o.id===orderId);
            orders[idx] = { ...orders[idx], date:dateISO, time:timeStr, status:'scheduled' };
            const [y,m,d]=dateISO.split('-'), dateLabel=`${d}.${m}.${y}`;
            await tg('editMessageReplyMarkup',{ chat_id:chatId, message_id:cq.message.message_id,
              reply_markup:{ inline_keyboard:[
                [{ text:'✅ Выполнена',callback_data:`done:${orderId}` },{ text:'❌ Отказ',callback_data:`refused:${orderId}` }],
                [{ text:`📅 ${dateLabel} в ${timeStr}`,callback_data:`appoint:${orderId}` }]
              ]}
            });
            // Расписание
            if (brigadeNum) {
              const sched = orders.filter(o=>o.brigade==brigadeNum&&o.status==='scheduled'&&o.date)
                .sort((a,b)=>(a.date+(a.time||'')).localeCompare(b.date+(b.time||'')));
              if (sched.length) {
                let msg=`📅 *Ваше расписание — ${getBrigadeName(brigadeNum)}*\n\n`;
                sched.forEach((o,i)=>{ const[sy,sm,sd]=o.date.split('-');
                  msg+=`${i+1}. *${sd}.${sm}.${sy}* в *${o.time||'?'}*\n   ${o.name}${o.phone?' · '+o.phone:''}\n   📍 ${o.city||''}${o.address?', '+o.address:''}\n${o.marker?'   🔖 '+o.marker+'\n':''}\n`; });
                await tg('sendMessage',{ chat_id:chatId, text:msg, parse_mode:'Markdown',
                  reply_markup:{ inline_keyboard:sched.map(o=>[{ text:`🔖 ${o.marker||o.id} · ${o.name}`,callback_data:`my_order:${o.id}` }]) }
                });
              }
            }
          }
          continue;
        }

        // Первое нажатие done/refused — подтверждение
        if (cb.startsWith('done:') || cb.startsWith('refused:')) {
          const isR=cb.startsWith('refused:'), orderId=cb.split(':')[1], origMsgId=cq.message.message_id;
          const order=orders.find(o=>o.id===orderId&&o.status!=='done'&&o.status!=='refused');
          await tg('answerCallbackQuery',{ callback_query_id:cq.id, text:'' });
          if (!order) continue;
          await tg('editMessageReplyMarkup',{ chat_id:chatId, message_id:origMsgId,
            reply_markup:{ inline_keyboard:[[{ text:'⏳ Ожидает подтверждения...', callback_data:'noop' }]] }
          });
          await tg('sendMessage',{ chat_id:chatId, parse_mode:'Markdown',
            text: isR ? `❓ Подтвердите *отказ клиента*:\n*${order.name}*\n${order.marker?'🔖 '+order.marker:''}`
                      : `❓ Подтвердите *выполнение*:\n*${order.name}*\n${order.marker?'🔖 '+order.marker:''}`,
            reply_markup:{ inline_keyboard:[[
              { text:'✅ Да, подтвердить', callback_data:`${isR?'confirm_refused':'confirm_done'}:${orderId}:${origMsgId}` },
              { text:'❌ Отмена', callback_data:`cancel_confirm:${orderId}:${origMsgId}:${isR?'r':'d'}` }
            ]]}
          });
          continue;
        }

        // Отмена
        if (cb.startsWith('cancel_confirm:')) {
          const [,orderId,origMsgId] = cb.split(':');
          const order = orders.find(o=>o.id===orderId);
          await tg('answerCallbackQuery',{ callback_query_id:cq.id, text:'Отменено' });
          await tg('deleteMessage',{ chat_id:chatId, message_id:cq.message.message_id });
          if (order) {
            const [y,m,d]=(order.date||'---').split('-'), dL=order.date?`${d}.${m}.${y}`:null;
            await tg('editMessageReplyMarkup',{ chat_id:chatId, message_id:origMsgId,
              reply_markup:{ inline_keyboard:[
                [{ text:'✅ Выполнена',callback_data:`done:${orderId}` },{ text:'❌ Отказ',callback_data:`refused:${orderId}` }],
                [{ text:dL?`📅 ${dL} в ${order.time||'?'}`:'📅 Назначить дату/время', callback_data:`appoint:${orderId}` }]
              ]}
            });
          }
          continue;
        }

        // Подтверждение
        if (cb.startsWith('confirm_done:') || cb.startsWith('confirm_refused:')) {
          const isR=cb.startsWith('confirm_refused:'), parts=cb.split(':');
          const orderId=parts[1], origMsgId=parts[2];
          const idx=orders.findIndex(o=>o.id===orderId&&o.status!=='done'&&o.status!=='refused');
          await tg('answerCallbackQuery',{ callback_query_id:cq.id,
            text: idx>=0 ? (isR?'❌ Отказ зафиксирован.':'✅ Выполнено!') : '⚠️ Уже обработана.' });
          await tg('deleteMessage',{ chat_id:chatId, message_id:cq.message.message_id });
          if (idx>=0) {
            orders[idx] = isR
              ? { ...orders[idx], status:'refused', brigade:'' }
              : { ...orders[idx], status:'done', doneAt:new Date().toISOString(), brigade:brigadeNum||orders[idx].brigade };
            await tg('editMessageReplyMarkup',{ chat_id:chatId, message_id:origMsgId,
              reply_markup:{ inline_keyboard:[[{ text:isR?'❌ Клиент отказался':'✅ Выполнено', callback_data:'ack' }]] }
            });
          }
          continue;
        }

        await tg('answerCallbackQuery',{ callback_query_id:cq.id, text:'' });
        continue;
      }

      // Текстовые сообщения
      const msg=upd.message;
      if (!msg?.text) continue;
      const chatId=String(msg.chat.id), text=msg.text.trim();
      const brigadeNum=getBrigadeNum(chatId);

      if (text==='/list'||text==='📋 Мои заявки'||text.toLowerCase()==='мои заявки') {
        if (!brigadeNum) { await tg('sendMessage',{chat_id:chatId,text:'⚠️ Ваш чат не привязан к бригаде.'}); continue; }
        const my=orders.filter(o=>o.brigade==brigadeNum&&!['done','refused'].includes(o.status));
        const sched=my.filter(o=>o.status==='scheduled').sort((a,b)=>(a.date||'').localeCompare(b.date||''));
        const unsched=my.filter(o=>o.status!=='scheduled');
        let reply=`📋 *Ваши заявки — ${getBrigadeName(brigadeNum)}*\n`;
        if (!my.length) { reply+='\nНет активных заявок ✅'; }
        else {
          if (sched.length) { reply+=`\n📅 *Назначенные (${sched.length}):*\n`; sched.forEach((o,i)=>{ const[y,m,d]=(o.date||'--').split('-'); reply+=`${i+1}. ${d}.${m}.${y} в ${o.time||'?'} — ${o.name}${o.marker?' ('+o.marker+')':''}\n`; }); }
          if (unsched.length) { reply+=`\n🆕 *Не назначены (${unsched.length}):*\n`; unsched.forEach((o,i)=>{ reply+=`${i+1}. ${o.name}${o.marker?' ('+o.marker+')':''}\n`; }); }
        }
        await tg('sendMessage',{chat_id:chatId,text:reply,parse_mode:'Markdown',
          reply_markup:{inline_keyboard:my.map(o=>[{text:`🔖 ${o.marker||o.id} · ${o.name}`,callback_data:`my_order:${o.id}`}])}});
        await tg('sendMessage',{chat_id:chatId,text:'👇 Нажмите кнопку для обновления',
          reply_markup:{keyboard:[[{text:'📋 Мои заявки'}]],resize_keyboard:true,persistent:true}});
        continue;
      }

      const dm=text.match(/^(готово|выполнено|\/done)\s+(.+)/i);
      if (dm) {
        const marker=dm[2].trim();
        const idx=orders.findIndex(o=>o.marker?.toLowerCase()===marker.toLowerCase()&&o.brigade==brigadeNum);
        if (idx>=0) {
          orders[idx]={...orders[idx],status:'done',doneAt:new Date().toISOString()};
          await tg('sendMessage',{chat_id:chatId,text:`✅ Заявка *${marker}* — ${orders[idx].name} выполнена.`,parse_mode:'Markdown'});
        } else {
          await tg('sendMessage',{chat_id:chatId,text:`⚠️ Заявка *${marker}* не найдена.`,parse_mode:'Markdown'});
        }
        continue;
      }
    }
  } catch(e) { console.error('Poll error:', e.message); }
}

setInterval(poll, 4000);
poll();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Kondei Bot running on port ${PORT}`));
