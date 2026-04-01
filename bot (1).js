const { Client, GatewayIntentBits, VoiceChannel } = require("discord.js");
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
} = require("@discordjs/voice");
const { Readable } = require("stream");

const VOICE_CHANNEL_ID = "1487492056396861611";
const RECONNECT_DELAY_MS = 5000;
const REJOIN_PAUSE_MS = 3000;
const CYCLE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// 20ms of PCM silence at 48kHz stereo 16-bit — keeps Discord from kicking the bot
const SILENCE_FRAME = Buffer.alloc(3840);

function createSilenceStream() {
  const readable = new Readable({ read() {} });
  const interval = setInterval(() => readable.push(SILENCE_FRAME), 20);
  readable.on("close", () => clearInterval(interval));
  return readable;
}

function startSilencePlayer(conn) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  const resource = createAudioResource(createSilenceStream(), {
    inputType: StreamType.Raw,
  });
  player.play(resource);
  conn.subscribe(player);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let connection = null;
let reconnecting = false;
let cycleTimer = null;

async function joinChannel(channel) {
  const conn = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 30_000);
    startSilencePlayer(conn);
    console.log(`Joined voice channel: ${channel.name} — silence stream started`);
  } catch (err) {
    conn.destroy();
    throw err;
  }

  return conn;
}

function scheduleDailyCycle(channel) {
  if (cycleTimer) clearTimeout(cycleTimer);

  cycleTimer = setTimeout(async () => {
    console.log("24-hour cycle — leaving voice channel briefly then rejoining");

    if (connection) {
      connection.destroy();
      connection = null;
    }

    reconnecting = false;

    await new Promise((res) => setTimeout(res, REJOIN_PAUSE_MS));

    console.log("Rejoining voice channel after 24-hour cycle");
    await maintainConnection(channel);
  }, CYCLE_DURATION_MS);
}

async function maintainConnection(channel) {
  if (reconnecting) return;
  reconnecting = true;

  while (true) {
    try {
      connection = await joinChannel(channel);

      scheduleDailyCycle(channel);

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        console.log("Disconnected — attempting to reconnect...");
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          connection.destroy();
          connection = null;
          reconnecting = false;
          maintainConnection(channel);
        }
      });

      connection.on(VoiceConnectionStatus.Destroyed, () => {
        if (cycleTimer) return;
        console.log("Connection destroyed — will reconnect...");
        connection = null;
        reconnecting = false;
        setTimeout(() => maintainConnection(channel), RECONNECT_DELAY_MS);
      });

      reconnecting = false;
      return;
    } catch (err) {
      console.error(`Failed to join — retrying in ${RECONNECT_DELAY_MS}ms:`, err.message);
      await new Promise((res) => setTimeout(res, RECONNECT_DELAY_MS));
    }
  }
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
    if (!channel || !(channel instanceof VoiceChannel)) {
      console.error("Channel not found or is not a voice channel. Check the VOICE_CHANNEL_ID.");
      process.exit(1);
    }
    console.log(`Found channel: ${channel.name} in ${channel.guild.name}`);
    await maintainConnection(channel);
  } catch (err) {
    console.error("Error joining voice channel:", err);
    process.exit(1);
  }
});

client.on("error", (err) => console.error("Discord client error:", err));

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("DISCORD_BOT_TOKEN environment variable is not set.");
  process.exit(1);
}

client.login(token);
