const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

let rooms = {}; // เก็บข้อมูลห้องทั้งหมด
let players = {}; // เก็บข้อมูลผู้เล่นทั้งหมด
const QUESTION_TIMEOUT = 30000; // 30 วินาทีต่อข้อ

// สร้างโจทย์คณิตศาสตร์ (บวกเลข 2 หลัก)
function generateMathQuestion() {
    const num1 = Math.floor(Math.random() * 90) + 10; // 10-99
    const num2 = Math.floor(Math.random() * 90) + 10; // 10-99
    const correctAnswer = num1 + num2;
    
    // สร้างตัวเลือก 4 ตัว
    let answers = [correctAnswer];
    while (answers.length < 4) {
        const wrongAnswer = correctAnswer + Math.floor(Math.random() * 20) - 10;
        if (wrongAnswer !== correctAnswer && wrongAnswer > 0 && !answers.includes(wrongAnswer)) {
            answers.push(wrongAnswer);
        }
    }
    
    // สลับตำแหน่งตัวเลือก
    answers = answers.sort(() => Math.random() - 0.5);
    
    return {
        question: `${num1} + ${num2} = ?`,
        answers: answers,
        correctAnswer: correctAnswer
    };
}

io.on('connection', (socket) => {
    console.log(`เชื่อมต่อแล้ว ID: ${socket.id}`);

    // ส่งรายชื่อห้องทั้งหมดให้ผู้เล่น
    socket.emit('roomList', rooms);

    // Reconnect to room
    socket.on('reconnectToRoom', (data) => {
        const roomId = data.roomId;
        const playerName = data.playerName;
        const car = data.car;
        
        console.log(`Player ${playerName} attempting to reconnect to room ${roomId}`);
        
        if (rooms[roomId]) {
            const room = rooms[roomId];
            
            // ค้นหาผู้เล่นเก่าในห้อง
            let existingPlayer = null;
            let oldSocketId = null;
            
            for (let socketId in room.players) {
                if (room.players[socketId].name === playerName && room.players[socketId].car === car) {
                    existingPlayer = room.players[socketId];
                    oldSocketId = socketId;
                    break;
                }
            }
            
            if (existingPlayer) {
                // อัปเดต socket ID ใหม่
                delete room.players[oldSocketId];
                players[socket.id] = {
                    ...existingPlayer,
                    roomId: roomId
                };
                room.players[socket.id] = players[socket.id];
                
                socket.join(roomId);
                
                // ส่งข้อมูลกลับไปให้ client
                socket.emit('reconnectSuccess', {
                    roomId: roomId,
                    isHost: room.host === socket.id,
                    players: room.players,
                    status: room.status,
                    currentQuestion: room.currentQuestion
                });
                
                // แจ้งผู้เล่นคนอื่นในห้อง
                io.to(roomId).emit('updateLobby', room.players);
                
                console.log(`${playerName} reconnected successfully to room ${roomId}`);
            } else {
                // ไม่พบผู้เล่นเก่า
                socket.emit('reconnectFailed', 'ไม่พบข้อมูลผู้เล่นในห้อง กรุณาเข้าร่วมห้องใหม่');
            }
        } else {
            // ห้องไม่มีอยู่แล้ว
            socket.emit('reconnectFailed', 'ห้องไม่มีอยู่แล้ว กรุณาเข้าร่วมห้องใหม่');
        }
    });

    // สร้างห้องใหม่
    socket.on('createRoom', (data) => {
        console.log('Received createRoom event:', data);
        
        const roomId = 'room_' + Date.now();
        rooms[roomId] = {
            id: roomId,
            name: data.roomName,
            host: socket.id,
            players: {},
            status: 'lobby', // lobby, playing, finished
            currentQuestion: null,
            questionNumber: 0,
            questionStartTime: null,
            answeredPlayers: [],
            questionTimeout: null
        };
        
        players[socket.id] = {
            roomId: roomId,
            name: data.playerName,
            car: data.car,
            score: 0,
            position: 0,
            totalDistance: 0
        };
        
        rooms[roomId].players[socket.id] = players[socket.id];
        
        socket.join(roomId);
        socket.emit('roomCreated', roomId);
        
        // ส่ง roomList โดยลบ timeout ออก
        const roomListForClient = {};
        for (let id in rooms) {
            roomListForClient[id] = {
                ...rooms[id],
                questionTimeout: undefined
            };
        }
        io.emit('roomList', roomListForClient);
        io.to(roomId).emit('updateLobby', rooms[roomId].players);
        
        console.log(`สร้า️ห้อง ${roomId} โดย ${data.playerName}`);
    });

    // เข้าร่วมห้อง
    socket.on('joinRoom', (data) => {
        const roomId = data.roomId;
        if (rooms[roomId] && rooms[roomId].status === 'lobby') {
            players[socket.id] = {
                roomId: roomId,
                name: data.playerName,
                car: data.car,
                score: 0,
                position: 0,
                totalDistance: 0
            };
            
            rooms[roomId].players[socket.id] = players[socket.id];
            
            socket.join(roomId);
            socket.emit('joinedRoom', roomId);
            
            // ส่ง roomList โดยลบ timeout ออก
            const roomListForClient = {};
            for (let id in rooms) {
                roomListForClient[id] = {
                    ...rooms[id],
                    questionTimeout: undefined
                };
            }
            io.emit('roomList', roomListForClient);
            io.to(roomId).emit('updateLobby', rooms[roomId].players);
            
            console.log(`${data.playerName} เข้าห้อง ${roomId}`);
        } else {
            socket.emit('joinError', 'ไม่สามารถเข้าห้องได้');
        }
    });

    // เริ่มเกม (เฉพาะเจ้าของห้อง)
    socket.on('startGame', (roomId) => {
        if (rooms[roomId] && rooms[roomId].host === socket.id) {
            rooms[roomId].status = 'playing';
            rooms[roomId].questionNumber = 0;
            
            // รีเซ็ตคะแนนทุกคน
            for (let playerId in rooms[roomId].players) {
                rooms[roomId].players[playerId].score = 0;
                rooms[roomId].players[playerId].position = 0;
                rooms[roomId].players[playerId].totalDistance = 0;
            }
            
            io.to(roomId).emit('gameStarted');
            io.to(roomId).emit('updateRace', rooms[roomId].players);
            
            // เริ่ม countdown
            let countdown = 3;
            io.to(roomId).emit('countdown', countdown);
            
            const countdownInterval = setInterval(() => {
                countdown--;
                if (countdown > 0) {
                    io.to(roomId).emit('countdown', countdown);
                } else {
                    clearInterval(countdownInterval);
                    // ส่งโจทย์แรก
                    sendQuestion(roomId);
                }
            }, 1000);
            
            console.log(`เริ่มเกมในห้อง ${roomId}`);
        }
    });

    // ส่งโจทย์คำถาม
    function sendQuestion(roomId) {
        if (rooms[roomId] && rooms[roomId].status === 'playing') {
            // เคลียร์ timeout เก่าถ้ามี
            if (rooms[roomId].questionTimeout) {
                clearTimeout(rooms[roomId].questionTimeout);
            }
            
            const question = generateMathQuestion();
            rooms[roomId].currentQuestion = question;
            rooms[roomId].questionNumber++;
            rooms[roomId].questionStartTime = Date.now();
            rooms[roomId].answeredPlayers = [];
            
            io.to(roomId).emit('newQuestion', question);
            
            // ตั้ง timeout 30 วินาที
            rooms[roomId].questionTimeout = setTimeout(() => {
                processRoundResults(roomId);
            }, QUESTION_TIMEOUT);
        }
    }
    
    // ประมวลผลรอบข้อสอบ
    function processRoundResults(roomId) {
        if (!rooms[roomId] || rooms[roomId].status !== 'playing') return;
        
        const room = rooms[roomId];
        const playerIds = Object.keys(room.players);
        
        // คำนวณระยะทางสำหรับผู้เล่นที่ตอบถูก
        playerIds.forEach(playerId => {
            const player = room.players[playerId];
            if (player.answerTime && player.isCorrect) {
                // คำนวณระยะทางตามความเร็ว (เร็วกว่า = ไกลกว่า)
                // สูงสุด 10 วินาที = 100% ระยะทาง
                const timeTaken = player.answerTime - room.questionStartTime;
                const maxTime = 10000; // 10 วินาที
                const speedBonus = Math.max(0, 1 - (timeTaken / maxTime));
                const distanceGain = speedBonus * 10; // สูงสุด 10 หน่วยต่อข้อ
                
                player.totalDistance += distanceGain;
                player.position = Math.min(100, (player.totalDistance / 100) * 100);
                player.score++;
            }
            
            // รีเซ็ตสถานะการตอบ
            player.answerTime = null;
            player.isCorrect = false;
        });
        
        io.to(roomId).emit('updateRace', room.players);
        
        // เช็คว่ามีคนชนะหรือยัง (ถึงเส้นชัย)
        const winner = playerIds.find(id => room.players[id].position >= 100);
        if (winner) {
            room.status = 'finished';
            
            // ส่งข้อมูลผู้เล่นทั้งหมดพร้อมลำดับ
            const sortedPlayers = playerIds
                .map(id => room.players[id])
                .sort((a, b) => b.totalDistance - a.totalDistance);
            
            io.to(roomId).emit('gameFinished', {
                winner: room.players[winner],
                rankings: sortedPlayers
            });
            console.log(`${room.players[winner].name} ชนะในห้อง ${roomId}`);
        } else {
            // ส่งโจทย์ใหม่
            setTimeout(() => sendQuestion(roomId), 2000);
        }
    }

    // รีเซ็ตห้องกลับเป็น lobby
    socket.on('resetRoom', (roomId) => {
        if (rooms[roomId]) {
            rooms[roomId].status = 'lobby';
            rooms[roomId].currentQuestion = null;
            rooms[roomId].questionNumber = 0;
            rooms[roomId].questionStartTime = null;
            rooms[roomId].answeredPlayers = [];
            
            if (rooms[roomId].questionTimeout) {
                clearTimeout(rooms[roomId].questionTimeout);
                rooms[roomId].questionTimeout = null;
            }
            
            io.to(roomId).emit('roomReset');
            io.to(roomId).emit('updateLobby', rooms[roomId].players);
            
            console.log(`ห้อง ${roomId} ถูกรีเซ็ตกลับเป็น lobby`);
        }
    });

    // ตอบคำถาม
    socket.on('submitAnswer', (data) => {
        const playerId = socket.id;
        const player = players[playerId];
        
        if (player && rooms[player.roomId]) {
            const room = rooms[player.roomId];
            const currentQuestion = room.currentQuestion;
            
            if (currentQuestion && !room.answeredPlayers.includes(playerId)) {
                // บันทึกเวลาตอบและความถูกต้อง
                player.answerTime = Date.now();
                player.isCorrect = (data.answer === currentQuestion.correctAnswer);
                room.answeredPlayers.push(playerId);
                
                // แจ้งให้ผู้เล่นรู้ว่าตอบแล้ว
                socket.emit('answerSubmitted', { isCorrect: player.isCorrect });
                
                // เช็คว่าทุกคนตอบหมดหรือยัง
                const totalPlayers = Object.keys(room.players).length;
                if (room.answeredPlayers.length >= totalPlayers) {
                    // ทุกคนตอบแล้ว ประมวลผลทันที
                    if (room.questionTimeout) {
                        clearTimeout(room.questionTimeout);
                    }
                    processRoundResults(room.id);
                }
            }
        }
    });


    // ออกจากห้อง
    socket.on('leaveRoom', () => {
        const player = players[socket.id];
        if (player && player.roomId && rooms[player.roomId]) {
            const roomId = player.roomId;
            delete rooms[roomId].players[socket.id];
            delete players[socket.id];
            
            socket.leave(roomId);
            io.to(roomId).emit('updateLobby', rooms[roomId].players);
            
            // ส่ง roomList โดยลบ timeout ออก
            const roomListForClient = {};
            for (let id in rooms) {
                roomListForClient[id] = {
                    ...rooms[id],
                    questionTimeout: undefined
                };
            }
            io.emit('roomList', roomListForClient);
            
            // ถ้าห้องว่าง ลบห้อง
            if (Object.keys(rooms[roomId].players).length === 0) {
                delete rooms[roomId];
                const roomListForClient = {};
                for (let id in rooms) {
                    roomListForClient[id] = {
                        ...rooms[id],
                        questionTimeout: undefined
                    };
                }
                io.emit('roomList', roomListForClient);
            }
        }
    });

    // เมื่อผู้เล่นตัดการเชื่อมต่อ
    socket.on('disconnect', () => {
        const player = players[socket.id];
        if (player && player.roomId && rooms[player.roomId]) {
            const roomId = player.roomId;
            delete rooms[roomId].players[socket.id];
            delete players[socket.id];
            
            io.to(roomId).emit('updateLobby', rooms[roomId].players);
            
            // ส่ง roomList โดยลบ timeout ออก
            const roomListForClient = {};
            for (let id in rooms) {
                roomListForClient[id] = {
                    ...rooms[id],
                    questionTimeout: undefined
                };
            }
            io.emit('roomList', roomListForClient);
            
            if (Object.keys(rooms[roomId].players).length === 0) {
                delete rooms[roomId];
                const roomListForClient2 = {};
                for (let id in rooms) {
                    roomListForClient2[id] = {
                        ...rooms[id],
                        questionTimeout: undefined
                    };
                }
                io.emit('roomList', roomListForClient2);
            }
            
            console.log(`${player.name} ออกจากเกม`);
        }
    });
});

http.listen(3000, () => {
    console.log('พร้อมแล้ว! เปิดเว็บไปที่ http://localhost:3000');
});