import dotenv from 'dotenv'; dotenv.config();

import express from 'express';
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';

import { PrismaClient } from "@prisma/client";
import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import axios from "axios";
import { Storage } from "@google-cloud/storage";

import session from 'cookie-session';
import bodyParser from 'body-parser';
import passport from 'passport';
import { Strategy } from 'passport-local';
import { ensureLoggedIn } from 'connect-ensure-login';

import OpenAI from 'openai';

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Prisma and GCloud
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/////////////////////////////
// Prisma
/////////////////////////////

const prismadb = new PrismaClient();

/////////////////////////////
// GCloud
/////////////////////////////

const key = JSON.parse(process.env.GCLOUD_KEY!);
const storageOptions = {
    projectId: key.projectId,
    credentials: {
          client_email: key.client_email,
          private_key: key.private_key
    }
};
const storage = new Storage(storageOptions);
const bucketName = "pusheen";
const bucket = storage.bucket(bucketName);

const uploadByteToFile = async ({ data, title }: {data: any, title: string}) => {    
  const file = bucket.file(title);
  const contents = Buffer.from(data.replace(/^data:image\/(png|gif|jpeg);base64,/, ''), 'base64');
  
  await file.save(contents).then(() => console.log(`Saved ${title}`));
}

const uploadAudioByteToFile = async ({ data, title }: {data: any, title: string}) => {    
  const file = bucket.file(title);
  await file.save(data).then(() => console.log(`Saved ${title}`));
}

export const checkFileExists = async ({directory, fileName}: any) => {
  const file = bucket.file(`${directory}/${fileName}`);

  let exists = false;

  await file.exists().then((data) => {
      exists = data[0];
  });

  return exists;
}

/////////////////////////////
// GPT API
/////////////////////////////

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!, // This is the default and can be omitted
});

const extractSentences = (rawSentences: string) => {
  const regex = /\(([^)]+)\)/g;

  // Extract and return all matches
  const sentences = [];
  let match;
  while ((match = regex.exec(rawSentences)) !== null) {
      sentences.push(match[1]);
  }

  return sentences;
}

const getScript = async ({ prompt }: {prompt: string}) => {
  const messages: any = [
    { role: 'user', content: `You are a narrator for a children's educational story. The topic is to explain ${prompt} through a story that is both entertaining and understandable to a child. There is a main character named Pusheen in this story who has to discover the lesson about ${prompt}. This character is a cute cat who represents the child wanting to learn.
    **Write the story as a series of THREE scenes each enclosed within parantheses ( and ).
    DO NOT ADD TITLES TO EACH SCENE. DO NOT GO OVER THREE SCENES. You will be *penalized* for adding extra commentary or titles (e.g., describing as "Scene 1" for each scene or for forgetting the numbering) and you will be heavily penalized for adding more than THREE scenes.
    For example,
    (Pusheen woke up)
    (Pusheen did something)
    (Then this happened)
    **` }
  ];

  let response = await openai.chat.completions.create({
    messages,
    "model": "gpt-4-turbo-preview"
  });
  if (!response) {
    throw new Error("Error querying ChatGPT.");
  }
  const storyString = response.choices[0].message.content;

  messages.push({
    role: 'assistant',
    content: storyString
  }, {
    role: 'user',
    content: `Describe each scene  in vivid but CONCISE details. Do NOT use complete sentences - instead, describe what Pusheen is doing and where she is / her environment. 
    You will be *penalized* heavily for being too wordy or deviating from this format. Please follow the same format as before with each scene's response enclosed within parantheses ( and ). For example,
    You will be *penalized* for adding extra commentary or titles (e.g., describing as "Scene 1" for each scene or for forgetting the numbering) and you will be heavily penalized for adding more than THREE scenes.
    For example,
    (Pusheen sitting on a couch, bright morning, sun shining)
    (Pusheen playing outside, sunflowers and tall grass, fluffy clouds)
    (Pusheen in the school play, dancing with friends, show lights on)`
  });
  response = await openai.chat.completions.create({
    messages,
    "model": "gpt-4-turbo-preview"
  });
  if (!response) {
    throw new Error("Error querying ChatGPT.");
  }
  const promptsString = response.choices[0].message.content;

  const story = extractSentences(storyString!);
  const prompts = extractSentences(promptsString!);

  await getImages({ prompts });
  await getAudios({ story });

  return { story: [], prompts: [] };
}

/////////////////////////////
// SD API
/////////////////////////////

const getImage = async ({ prompt, sceneNumber }: {prompt: string, sceneNumber: number}) => {
  const params = {
    "api": {
      "method": "POST",
      "endpoint": "/sdapi/v1/txt2img"
    },
    "payload": {
      "override_settings": {
        "sd_model_checkpoint": "base"
      },
      "override_settings_restore_afterwards": true,
      "prompt": prompt + " (no humans) <lora:Pusheen:1>",
      "negative_prompt": "embedding:negs\nsfwEM, too many legs, deformity",
      "seed": -1,
      "batch_size": 1,
      "steps": 30,
      "cfg_scale": 6,
      "width": 512,
      "height": 512,
      "sampler_name": "DPM++ 2M Karras",
      "sampler_index": "DPM++ 2M Karras",
      "restore_faces": false
    }
  };

  const response = await axios.post("https://api.runpod.ai/v2/yc2fkxtvuqg3rr/runsync", {
    "input": params,
  }, {
    "headers": {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.RUNPOD_API_KEY}`
    }
  })
  .then(async (res) => {
    await uploadByteToFile({
      data: res.data.output?.images[0],
      title: `scene_${sceneNumber}.jpg`
    });
  }).catch(() => {
    throw new Error(`Failed to process image ${sceneNumber}`);
  });
}

const getImages = async ({ prompts }: { prompts: string[] }) => {
  await Promise.all(
    prompts.map((prompt, index) => {
      return getImage({ prompt, sceneNumber: index });
    })
 );
}

/////////////////////////////
// ELABS API
/////////////////////////////

const getAudio = async ({ scene, sceneNumber }: { scene: string, sceneNumber: number }) => {
  let params = {
    "model_id": "eleven_monolingual_v1",
    "text": scene, 
    "voice_settings": {
      "similarity_boost": 0.5,
      "stability": 0.5
    }
  };

  await axios.post(
    "https://api.elevenlabs.io/v1/text-to-speech/XrExE9yKIg1WjnnlVkGX",
    params, {
      "headers": {
        "Content-Type": "application/json",
        "xi-api-key": `${process.env.ELEVENLABS_API_KEY}`,
      },
      "responseType": "arraybuffer"
    }
  )
    .then(async (response) => {
      await uploadAudioByteToFile({ data: response.data, title: `scene_${sceneNumber}.mp3` });
    })
    .catch((err) => console.error(err));
}

const getAudios = async ({ story }: {story: string[]}) => {
  await Promise.all(
    story.map((scene, index) => {
      return getAudio({ scene, sceneNumber: index });
    })
 );
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Bull
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const redisConnection = { 
  connection: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT as string),
    password: process.env.REDIS_PASSWORD
  }
};

const jobQueue = new Queue("job", redisConnection);

const jobWorker = new Worker("job", 
  async (request: Job) => {
    const { jobId } = request.data;
    
    const job = await prismadb.job.findUnique({ where: { id: jobId } });
    if (!job) throw new Error("Job not found with id");
    const storyPrompt = job.prompt;

    const { story, prompts } = await getScript({ prompt: storyPrompt });
    await getImages({ prompts });
    // await getAudios({ prompts });

    return 'Job processed';
  }, 
  {
    concurrency: 100,
    ...redisConnection,
    removeOnComplete: { count: 1000 }
  }
);

jobWorker.on("failed", async (job?: Job, error?: Error) => {
  try {
    
  } catch (error) {
    console.log("Error with convert worker error handling.");
  }
});

jobWorker.on('error', err => {
  console.error(err);
});

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Server
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/ui');

createBullBoard({
  queues: [
    new BullMQAdapter(jobQueue)
  ],
  serverAdapter: serverAdapter,
});

const app = express();

passport.use(
  new Strategy(function (username: any, password: any, cb: any) {
    if (username === 'admin' && password === process.env.PASSWORD) {
      return cb(null, { user: 'bull-board' });
    }
    return cb(null, false);
  })
);
passport.serializeUser((user: any, cb: any) => {
  cb(null, user);
});
passport.deserializeUser((user: any, cb: any) => {
  cb(null, user);
});

app.set('views', './views');
app.set('view engine', 'ejs');

app.use(session({ secret: process.env.LOGIN_COOKIE }));
app.use(bodyParser.urlencoded({ extended: false }));

// Initialize Passport and restore authentication state, if any, from the session.
app.use(passport.initialize({}));
app.use(passport.session());

app.get('/ui/login', (req, res) => {
  res.render('login', { invalid: req.query.invalid === 'true' });
});

app.post(
  '/ui/login',
  passport.authenticate('local', { failureRedirect: '/ui/login?invalid=true' }),
  (req, res) => {
    res.redirect('/ui');
  }
);

app.use('/ui', ensureLoggedIn({ redirectTo: '/ui/login' }), serverAdapter.getRouter());
app.use(express.json());

app.post('/api/submit', async (req, res) => {
  const { jobId } = req.body;
  await jobQueue.add(`job_${jobId}`, { jobId });
  res.send("Job queued");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Public domain: ${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  console.log(`Running on port ${port}...`);
});

// getScript({ prompt: "photosynthesis" });
