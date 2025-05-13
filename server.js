require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
const http = require('http');
const admin = require('firebase-admin');
const axios = require('axios'); // For fetching questions from external API

// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


const atlasUri = process.env.ATLAS_URI;
mongoose.connect(atlasUri)
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch(err => console.error('❌ MongoDB connection error:', err));


// Database Models
const Room = mongoose.model('Room', {
  code: String,
  host: String,
  category: String,
  quizCount: Number,
  maxPlayers: Number,
  players: [{
    id: String,
    name: String,
    ready: Boolean,
    score: Number
  }],
  isPublic: Boolean,
  status: { type: String, enum: ['waiting', 'in-progress', 'completed'], default: 'waiting' },
  createdAt: { type: Date, default: Date.now }
});

const Game = mongoose.model('Game', {
  roomCode: String,
  questions: [{
    text: String,
    options: [String],
    correctAnswer: String,
    timeLimit: Number
  }],
  currentQuestion: Number,
  scores: [{
    playerId: String,
    playerName: String,
    score: Number,
    answers: [{
      questionIndex: Number,
      answer: String,
      isCorrect: Boolean,
      timeTaken: Number
    }]
  }],
  startedAt: Date,
  endedAt: Date
});

const Question = mongoose.model('Question', {
  category: String,
  difficulty: String,
  question: String,
  correctAnswer: String,
  incorrectAnswers: [String],
  source: { type: String, default: 'opentdb' }
});

// Express Setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Verify Firebase Token
const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Helper Functions
const fetchQuestions = async (category, count) => {
  try {
    // Try to get questions from our database first
    let questions = await Question.aggregate([
      { $match: { category } },
      { $sample: { size: count } },
      { $project: {
        text: '$question',
        correctAnswer: 1,
        options: { $concatArrays: [['$correctAnswer'], '$incorrectAnswers'] },
        category: 1,
        difficulty: 1
      }}
    ]);

    // If not enough questions, fetch from OpenTDB
    if (questions.length < count) {
      const apiUrl = `https://opentdb.com/api.php?amount=${count}&category=${getCategoryId(category)}`;
      const response = await axios.get(apiUrl);
      
      const apiQuestions = response.data.results.map(q => ({
        text: decodeHtmlEntities(q.question),
        correctAnswer: decodeHtmlEntities(q.correct_answer),
        options: shuffleArray([...q.incorrect_answers.map(decodeHtmlEntities), decodeHtmlEntities(q.correct_answer)]),
        category: q.category,
        difficulty: q.difficulty
      }));

      questions = [...questions, ...apiQuestions].slice(0, count);
    }

    return questions;
  } catch (err) {
    console.error('Error fetching questions:', err);
    throw new Error('Failed to fetch questions');
  }
};

const decodeHtmlEntities = (text) => {
  return text.replace(/&quot;/g, '"')
             .replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&#039;/g, "'");
};

const shuffleArray = (array) => {
  return array.sort(() => Math.random() - 0.5);
};

const getCategoryId = (category) => {
  const categories = {
    'General Knowledge': 9,
    'Science': 17,
    'History': 23,
    'Movies': 11,
    'Sports': 21,
    'Random': 0
  };
  return categories[category] || 0;
};

// API Routes
app.post('/api/rooms', verifyToken, async (req, res) => {
  try {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const room = new Room({
      code,
      host: req.user.uid,
      category: req.body.category,
      quizCount: req.body.quizCount,
      maxPlayers: req.body.maxPlayers,
      players: [{
        id: req.user.uid,
        name: req.body.playerName,
        ready: false,
        score: 0
      }],
      isPublic: req.body.isPublic
    });

    await room.save();
    res.json(room);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

app.get('/api/rooms/public', verifyToken, async (req, res) => {
  try {
    const rooms = await Room.find({ 
      isPublic: true,
      status: 'waiting'
    });
    res.json(rooms);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load rooms' });
  }
});

app.post('/api/rooms/quick-match', verifyToken, async (req, res) => {
  try {
    // Find available quick match room
    let room = await Room.findOne({ 
      isPublic: true,
      category: 'Random',
      status: 'waiting',
      'players.1': { $exists: false } // Room with 1 player
    });

    if (!room) {
      // Create new quick match room
      const code = Math.floor(1000 + Math.random() * 9000).toString();
      room = new Room({
        code,
        host: req.user.uid,
        category: 'Random',
        quizCount: 5,
        maxPlayers: 2,
        players: [{
          id: req.user.uid,
          name: req.body.playerName,
          ready: false,
          score: 0
        }],
        isPublic: true
      });
      await room.save();
    } else {
      // Join existing room
      room.players.push({
        id: req.user.uid,
        name: req.body.playerName,
        ready: false,
        score: 0
      });
      await room.save();
    }

    res.json(room);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to find match' });
  }
});

app.post('/api/rooms/:code/join', verifyToken, async (req, res) => {
  try {
    const room = await Room.findOne({ code: req.params.code });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.players.length >= room.maxPlayers) {
      return res.status(400).json({ error: 'Room is full' });
    }
    if (room.status !== 'waiting') {
      return res.status(400).json({ error: 'Game has already started' });
    }

    room.players.push({
      id: req.user.uid,
      name: req.body.playerName,
      ready: false,
      score: 0
    });

    await room.save();
    io.to(room.code).emit('roomUpdated', room);
    res.json(room);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to join room' });
  }
});

app.get('/api/games/:roomCode', verifyToken, async (req, res) => {
  try {
    const game = await Game.findOne({ roomCode: req.params.roomCode });
    if (!game) return res.status(404).json({ error: 'Game not found' });
    res.json(game);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get game data' });
  }
});

// Socket.io Authentication
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('Authentication failed'));
  }
});

// Socket.io Events
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.user.uid}`);

  socket.on('joinRoom', async (roomCode) => {
    socket.join(roomCode);
    console.log(`User ${socket.user.uid} joined room ${roomCode}`);

    // Send current room state to the new user
    const room = await Room.findOne({ code: roomCode });
    if (room) {
      socket.emit('roomUpdated', room);
    }
  });

  socket.on('playerReady', async ({ roomCode, isReady }) => {
    try {
      const room = await Room.findOne({ code: roomCode });
      if (!room) return;

      const player = room.players.find(p => p.id === socket.user.uid);
      if (player) {
        player.ready = isReady;
        await room.save();
        io.to(roomCode).emit('roomUpdated', room);

        // Check if all players are ready
        if (room.players.every(p => p.ready) && room.players.length >= 1) {
          if (room.players.length === 1) {
            // Single player can start immediately
            startGame(room);
          } else {
            // Multiplayer - wait for host to start
            io.to(room.host).emit('canStartGame');
          }
        }
      }
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('startGame', async (roomCode) => {
    try {
      const room = await Room.findOne({ code: roomCode });
      if (room && room.host === socket.user.uid && room.status === 'waiting') {
        startGame(room);
      }
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('submitAnswer', async ({ roomCode, questionIndex, answer, timeTaken }) => {
    try {
      const game = await Game.findOne({ roomCode });
      if (!game || game.endedAt) return;

      const playerScore = game.scores.find(s => s.playerId === socket.user.uid);
      if (!playerScore) return;

      // Check if already answered
      const existingAnswer = playerScore.answers.find(a => a.questionIndex === questionIndex);
      if (existingAnswer) return;

      const question = game.questions[questionIndex];
      const isCorrect = question.correctAnswer === answer;

      playerScore.answers.push({
        questionIndex,
        answer,
        isCorrect,
        timeTaken
      });

      if (isCorrect) {
        // Calculate score based on time taken (faster = more points)
        const timeBonus = Math.max(0, 10 - Math.floor(timeTaken / 1000));
        playerScore.score += 100 + (timeBonus * 10);
      }

      await game.save();

      // Update all clients
      io.to(roomCode).emit('answerReceived', {
        playerId: socket.user.uid,
        questionIndex,
        isCorrect
      });

      // Check if all players have answered
      const allAnswered = game.scores.every(score => 
        score.answers.some(a => a.questionIndex === questionIndex)
      );

      if (allAnswered) {
        if (game.currentQuestion < game.questions.length - 1) {
          // Move to next question
          game.currentQuestion++;
          await game.save();
          io.to(roomCode).emit('nextQuestion', {
            questionIndex: game.currentQuestion,
            question: game.questions[game.currentQuestion]
          });
        } else {
          // Game over
          game.endedAt = new Date();
          await game.save();

          // Update room status
          const room = await Room.findOne({ code: roomCode });
          if (room) {
            room.status = 'completed';
            await room.save();
          }

          io.to(roomCode).emit('gameEnded', {
            scores: game.scores.sort((a, b) => b.score - a.score)
          });
        }
      }
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.user.uid}`);
  });
});

// Game Management Functions
const startGame = async (room) => {
  try {
    // Fetch questions
    const questions = await fetchQuestions(room.category, room.quizCount);

    // Create game record
    const game = new Game({
      roomCode: room.code,
      questions: questions.map(q => ({
        text: q.text,
        options: q.options,
        correctAnswer: q.correctAnswer,
        timeLimit: 15000 // 15 seconds per question
      })),
      currentQuestion: 0,
      scores: room.players.map(p => ({
        playerId: p.id,
        playerName: p.name,
        score: 0,
        answers: []
      })),
      startedAt: new Date()
    });

    await game.save();

    // Update room status
    room.status = 'in-progress';
    await room.save();

    // Notify all players
    io.to(room.code).emit('gameStarted', {
      questionIndex: 0,
      question: game.questions[0],
      totalQuestions: game.questions.length
    });
  } catch (err) {
    console.error('Error starting game:', err);
    io.to(room.code).emit('gameError', { message: 'Failed to start game' });
  }
};

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});