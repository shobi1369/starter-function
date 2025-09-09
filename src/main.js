import { Client, Databases, ID, Query } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  res.set('Content-Type', 'application/json');
  try {
    const update = JSON.parse(req.body || '{}');
    if (!update.message) {
      return res.status(200).send('');
    }

    const message = update.message;
    const chatId = message.chat.id.toString();
    const userId = message.from.id.toString();
    const text = message.text;

    const client = new Client()
      .setEndpoint('https://cloud.appwrite.io/v1')
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID);

    const databases = new Databases(client);
    const dbId = process.env.DATABASE_ID;

    // Get or create user
    let userDocs = await databases.listDocuments(dbId, 'users', [Query.equal('userId', userId)]);
    let userDoc;
    if (userDocs.documents.length === 0) {
      userDoc = await databases.createDocument(dbId, 'users', ID.unique(), {
        userId,
        username: message.from.username || '',
        usage: 0
      });
    } else {
      userDoc = userDocs.documents[0];
    }

    // Check usage limit
    if (userDoc.usage >= 5) {
      await sendMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, 'You got limited');
      await saveMessage(databases, dbId, chatId, userId, text, true);
      return res.status(200).send('');
    }

    // Save user message
    await saveMessage(databases, dbId, chatId, userId, text, true);

    // Fetch last 10 messages (order desc then reverse for chronological)
    const historyDocs = await databases.listDocuments(dbId, 'chats', [
      Query.equal('chatId', chatId),
      Query.orderDesc('$createdAt'),
      Query.limit(10)
    ]);
    const history = historyDocs.documents.reverse();
    const messages = history.map(doc => ({
      role: doc.isFromUser ? 'user' : 'assistant',
      content: doc.text
    }));

    // Add current user message
    messages.push({ role: 'user', content: text });

    // Add system prompt
    messages.unshift({ role: 'system', content: 'You are a helpful assistant.' });

    // Call OpenRouter
    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'moonshotai/kimi-k2:free',
        messages
      })
    });

    const aiData = await aiResponse.json();
    if (!aiResponse.ok) {
      throw new Error(aiData.error?.message || 'AI request failed');
    }

    const aiText = aiData.choices[0].message.content;

    // Send AI response to Telegram
    await sendMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, aiText);

    // Save bot message
    await saveMessage(databases, dbId, chatId, userId, aiText, false);

    // Increment usage
    await databases.updateDocument(dbId, 'users', userDoc.$id, {
      usage: userDoc.usage + 1
    });

    return res.status(200).send('');
  } catch (err) {
    log.error(err);
    return res.status(500).send('');
  }
};

async function sendMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096) }) // Telegram limit
  });
  if (!response.ok) {
    throw new Error(`Failed to send Telegram message: ${response.statusText}`);
  }
}

async function saveMessage(databases, dbId, chatId, userId, text, isFromUser) {
  await databases.createDocument(dbId, 'chats', ID.unique(), {
    chatId,
    userId,
    text,
    isFromUser
  });
}
