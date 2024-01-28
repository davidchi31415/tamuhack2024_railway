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
  apiKey: process.env.OPENAI_API_KEY, // This is the default and can be omitted
});

const queryGPT = async ({ message }: {message: string}) => {
  const chatCompletion = await openai.chat.completions.create({
    messages: [{ role: 'user', content: message }],
    model: 'gpt-3.5-turbo',
  });
};

const getScript = async ({ prompt }: {prompt: string}) => {
  const story = await queryGPT({
    message: `You are a narrator for a children's educational story. The topic is to explain photosynthesis through a story that is both entertaining and understandable to a child. There is a main character named Pusheen in this story who has to discover the lesson about photosynthesis. This character is a cute cat who represents the child wanting to learn.
    **Write the story as a series of scenes in a list numbered by their order. For example,
    1. ... Scene 1 ...
    2. ... Scene 2 ...
    ...
    DO NOT ADD TITLES TO EACH SCENE. You will be *penalized* for adding extra commentary or titles (e.g., describing as "Scene 1" for each scene or for forgetting the numbering).
    **`
  });
}

/////////////////////////////
// SD API
/////////////////////////////



/////////////////////////////
// ELABS API
/////////////////////////////



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
    
    

    // await axios.post("https://api.runpod.ai/v2/9afi4omg7sdwt6/run", {
    //   "input": {   
    //     "arguments": ""
    //   }
    // }, {
    //   "headers": {
    //     "Content-Type": "application/json",
    //     "Authorization": `Bearer ${process.env.RUNPOD_API_KEY}`
    //   }
    // })
    // .then(async (response) => {
    //   const runpodJobId = response.data.id;
    //   const status = "IN_PROGRESS";
    //   await prismadb.convertJob.update({
    //     where: { id: jobId },
    //     data: { 
    //         runpodJobId, 
    //         status
    //     }
    //   }).catch(() => {
    //     throw new Error("Failed to update database after successfully submitting job to RunPod");
    //   })
    // .catch(() => {
    //     throw new Error("Failed to submit convert job to RunPod"); 
    //   }); 
    // });

    return 'Convert request processed successfully';
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