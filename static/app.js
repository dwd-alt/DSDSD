let socket = null;
let currentUser = null;
let currentUserId = null;
let currentRoomId = 'general';
let currentRoomName = 'General';
let availableRooms = [];
let usersInRoom = [];
let peerConnection = null;
let localStream = null;
let currentCall = null;
let currentCallId = null;
let isCallActive = false;
let isMuted = false;
let isVideoEnabled = false;
let callType = 'audio';

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
};

// Загрузка комнат
async function loadRooms() {
    try {
        const response = await fetch('/api/rooms');
        availableRooms = await response.json();
        displayRoomsList();
    } catch (error) {
        console.error('Error loading rooms:', error);
    }
}

function displayRoomsList() {
    const roomsListDiv = document.getElementById('roomsList');
    if (!roomsListDiv) return;

    if (availableRooms.length === 0) {
        roomsListDiv.innerHTML = '<div class="no-rooms">Нет доступных комнат. Создайте первую!</div>';
        return;
    }

    roomsListDiv.innerHTML = availableRooms.map(room => `
        <div class="room-item" onclick="joinRoom('${room.id}', '${room.name}')">
            <div class="room-info">
                <strong>${escapeHtml(room.name)}</strong>
                <span class="room-details">
                    👥 ${room.users_count || 0} участников
                </span>
            </div>
        </div>
    `).join('');
}

function joinRoom(roomId, roomName) {
    const username = document.getElementById('username').value.trim();
    if (!username) {
        alert('Пожалуйста, введите ваше имя');
        return;
    }

    currentUser = username;
    currentRoomId = roomId;
    currentRoomName = roomName;

    connectToChat();
}

function connectToChat() {
    if (socket) {
        socket.disconnect();
    }

    socket = io();

    socket.on('connect', () => {
        console.log('Connected to server');

        socket.emit('register_user', {
            username: currentUser,
            room_id: currentRoomId
        });
    });

    socket.on('user_registered', (data) => {
        currentUserId = data.user_id;
        console.log('Registered with ID:', currentUserId);

        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('chatScreen').style.display = 'flex';
        document.getElementById('currentRoom').textContent = currentRoomName;
        document.getElementById('videoCallBtn').style.display = 'flex';
    });

    socket.on('users_list', (data) => {
        usersInRoom = data.users;
        updateUsersList();
        updateUsersCount(usersInRoom.length);
    });

    socket.on('user_joined', (data) => {
        addSystemMessage(`${data.username} присоединился к чату`);
        updateUsersCount(data.users_count);
    });

    socket.on('user_left', (data) => {
        addSystemMessage(`${data.username} покинул чат`);
        updateUsersCount(data.users_count);
        if (currentCall && (currentCall.callee_id === data.user_id || currentCall.caller_id === data.user_id)) {
            endCurrentCall();
        }
    });

    socket.on('incoming_call', (data) => {
        showIncomingCall(data);
    });

    socket.on('call_accepted', (data) => {
        startCallConnection(data);
    });

    socket.on('call_connected', (data) => {
        startCallConnection(data);
    });

    socket.on('call_rejected', (data) => {
        addSystemMessage(`${data.callee_name} отклонил(а) звонок`);
        endCurrentCall();
    });

    socket.on('call_ended', (data) => {
        addSystemMessage(`${data.ended_by} завершил(а) звонок`);
        endCurrentCall();
    });

    socket.on('call_error', (data) => {
        alert(data.message);
        endCurrentCall();
    });

    socket.on('webrtc_offer', async (data) => {
        await handleOffer(data);
    });

    socket.on('webrtc_answer', async (data) => {
        await handleAnswer(data);
    });

    socket.on('webrtc_ice_candidate', (data) => {
        handleIceCandidate(data);
    });

    socket.on('new_message', (message) => {
        displayMessage(message);
    });
}

function updateUsersList() {
    const usersListDiv = document.getElementById('usersList');
    if (!usersListDiv) return;

    usersListDiv.innerHTML = usersInRoom.map(user => `
        <div class="user-item ${user.id === currentUserId ? 'current-user' : ''}">
            <div class="user-info">
                <span class="user-status ${user.in_call ? 'in-call' : 'online'}"></span>
                <strong>${escapeHtml(user.username)}</strong>
                ${user.in_call ? '<span class="call-badge">📞 в звонке</span>' : ''}
            </div>
            ${user.id !== currentUserId && !user.in_call && !isCallActive ? `
                <div class="user-actions">
                    <button class="call-btn" onclick="startCall('${user.id}', 'audio')">🎤</button>
                    <button class="video-call-btn-small" onclick="startCall('${user.id}', 'video')">📹</button>
                </div>
            ` : ''}
        </div>
    `).join('');
}

function updateUsersCount(count) {
    document.getElementById('usersCount').textContent = count;
}

async function startCall(userId, type) {
    if (isCallActive) {
        alert('Вы уже в звонке');
        return;
    }

    callType = type;

    try {
        // Запрашиваем доступ к микрофону (и камере если видео)
        const constraints = {
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: type === 'video'
        };

        localStream = await navigator.mediaDevices.getUserMedia(constraints);

        console.log('Got local stream with audio tracks:', localStream.getAudioTracks().length);

        if (type === 'video') {
            const localVideo = document.getElementById('localVideo');
            localVideo.srcObject = localStream;
            isVideoEnabled = true;
            document.getElementById('toggleVideoBtn').style.display = 'flex';
            document.getElementById('toggleVideoBtn').innerHTML = '📹 Выкл';
        } else {
            document.getElementById('toggleVideoBtn').style.display = 'none';
        }

        document.getElementById('toggleMicBtn').innerHTML = '🎤 Выкл';
        isMuted = false;

        // Создаем PeerConnection
        createPeerConnection();

        // Добавляем локальные треки
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });

        // Создаем offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        // Отправляем offer через сокет
        socket.emit('webrtc_offer', {
            target_id: userId,
            caller_id: currentUserId,
            caller_name: currentUser,
            offer: offer
        });

        socket.emit('call_user', {
            caller_id: currentUserId,
            callee_id: userId,
            type: type
        });

        currentCall = { callee_id: userId, caller_id: currentUserId, type: type };
        showCallModal('calling', `Звонок ${type === 'video' ? 'видео' : 'голосовой'}...`);

    } catch (error) {
        console.error('Error accessing media devices:', error);
        alert('Не удалось получить доступ к микрофону/камере. Проверьте разрешения.');
    }
}

function startVideoCall() {
    const users = usersInRoom.filter(u => u.id !== currentUserId && !u.in_call);
    if (users.length === 0) {
        alert('Нет доступных пользователей для звонка');
        return;
    }
    startCall(users[0].id, 'video');
}

function showIncomingCall(data) {
    currentCallId = data.call_id;
    currentCall = {
        caller_id: data.caller_id,
        caller_name: data.caller_name,
        type: data.type
    };

    // Воспроизводим звук входящего звонка
    playRingtone();

    document.getElementById('callStatusText').textContent = `📞 Входящий ${data.type === 'video' ? 'видео' : 'голосовой'} звонок от ${data.caller_name}`;
    document.getElementById('incomingCallControls').style.display = 'flex';
    document.getElementById('callModal').style.display = 'flex';
}

function playRingtone() {
    // Создаем простой звук звонка
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 440;
    gainNode.gain.value = 0.3;

    oscillator.start();
    setTimeout(() => {
        oscillator.stop();
        audioContext.close();
    }, 2000);
}

async function acceptCall() {
    try {
        // Останавливаем звук звонка
        const constraints = {
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: currentCall.type === 'video'
        };

        localStream = await navigator.mediaDevices.getUserMedia(constraints);

        console.log('Got local stream for answering call');

        if (currentCall.type === 'video') {
            const localVideo = document.getElementById('localVideo');
            localVideo.srcObject = localStream;
            isVideoEnabled = true;
            document.getElementById('toggleVideoBtn').style.display = 'flex';
        }

        // Создаем PeerConnection
        createPeerConnection();

        // Добавляем локальные треки
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });

        document.getElementById('incomingCallControls').style.display = 'none';
        document.getElementById('callStatusText').textContent = 'Соединение...';

        socket.emit('accept_call', {
            call_id: currentCallId,
            callee_id: currentUserId
        });

        isCallActive = true;

    } catch (error) {
        console.error('Error accessing media devices:', error);
        alert('Не удалось получить доступ к микрофону/камере');
        rejectCall();
    }
}

function rejectCall() {
    socket.emit('reject_call', {
        call_id: currentCallId,
        callee_id: currentUserId
    });
    endCurrentCall();
}

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(configuration);

    peerConnection.ontrack = (event) => {
        console.log('Received remote track:', event.track.kind);
        const remoteVideo = document.getElementById('remoteVideo');
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
            console.log('Set remote stream');
        }
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            const targetId = currentCall && currentCall.callee_id ? currentCall.callee_id : currentCall.caller_id;
            if (targetId) {
                socket.emit('webrtc_ice_candidate', {
                    target_id: targetId,
                    candidate: event.candidate
                });
            }
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', peerConnection.iceConnectionState);
        if (peerConnection.iceConnectionState === 'disconnected' ||
            peerConnection.iceConnectionState === 'failed') {
            endCurrentCall();
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log('Connection state:', peerConnection.connectionState);
        if (peerConnection.connectionState === 'connected') {
            document.getElementById('callStatusText').textContent = 'В звонке...';
        }
    };
}

async function handleOffer(data) {
    try {
        if (!peerConnection) {
            createPeerConnection();

            // Добавляем локальные треки если их еще нет
            if (localStream) {
                localStream.getTracks().forEach(track => {
                    peerConnection.addTrack(track, localStream);
                });
            }
        }

        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        socket.emit('webrtc_answer', {
            target_id: data.caller_id,
            answer: answer,
            callee_id: currentUserId
        });
    } catch (error) {
        console.error('Error handling offer:', error);
    }
}

async function handleAnswer(data) {
    try {
        if (peerConnection && data.answer) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            console.log('Remote description set');
        }
    } catch (error) {
        console.error('Error handling answer:', error);
    }
}

function handleIceCandidate(data) {
    if (peerConnection && data.candidate) {
        peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate))
            .catch(error => console.error('Error adding ICE candidate:', error));
    }
}

async function startCallConnection(data) {
    isCallActive = true;

    // Если это ответ на исходящий звонок
    if (data.offer) {
        await handleOffer(data);
    }

    document.getElementById('callStatusText').textContent = 'Соединение установлено...';
    document.getElementById('callModal').style.display = 'flex';
}

function toggleMicrophone() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            isMuted = !audioTrack.enabled;
            document.getElementById('toggleMicBtn').innerHTML = isMuted ? '🎤 Вкл' : '🎤 Выкл';
        }
    }
}

function toggleVideo() {
    if (localStream && callType === 'video') {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            isVideoEnabled = videoTrack.enabled;
            document.getElementById('toggleVideoBtn').innerHTML = isVideoEnabled ? '📹 Выкл' : '📹 Вкл';
        }
    }
}

function endCurrentCall() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    if (isCallActive && currentUserId) {
        socket.emit('end_call', { user_id: currentUserId });
    }

    isCallActive = false;
    currentCall = null;
    currentCallId = null;
    isMuted = false;
    isVideoEnabled = false;
    callType = 'audio';

    const callModal = document.getElementById('callModal');
    if (callModal) {
        callModal.style.display = 'none';
    }

    const incomingControls = document.getElementById('incomingCallControls');
    if (incomingControls) {
        incomingControls.style.display = 'none';
    }

    const localVideo = document.getElementById('localVideo');
    const remoteVideo = document.getElementById('remoteVideo');
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
}

function showCallModal(status, message) {
    document.getElementById('callStatusText').textContent = message;
    document.getElementById('incomingCallControls').style.display = 'none';
    document.getElementById('callModal').style.display = 'flex';
}

function sendTextMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();

    if (!text) return;

    const message = {
        username: currentUser,
        text: text,
        type: 'text',
        room: currentRoomId,
        timestamp: new Date().toISOString()
    };

    fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
    })
    .then(() => {
        input.value = '';
    })
    .catch(error => console.error('Error sending message:', error));
}

function displayMessage(message) {
    const messagesDiv = document.getElementById('messages');
    const messageElement = document.createElement('div');
    messageElement.className = `message ${message.username === currentUser ? 'own-message' : 'other-message'}`;

    const timestamp = new Date(message.timestamp).toLocaleTimeString();

    messageElement.innerHTML = `
        <div class="message-header">
            <strong>${escapeHtml(message.username)}</strong>
            <span class="timestamp">${timestamp}</span>
        </div>
        <div class="message-content">
            <p>${escapeHtml(message.text)}</p>
        </div>
    `;

    messagesDiv.appendChild(messageElement);
    scrollToBottom();
}

function addSystemMessage(text) {
    const messagesDiv = document.getElementById('messages');
    const messageElement = document.createElement('div');
    messageElement.className = 'system-message';
    messageElement.innerHTML = `<em>${escapeHtml(text)}</em>`;
    messagesDiv.appendChild(messageElement);
    scrollToBottom();
}

function handleKeyPress(event) {
    if (event.key === 'Enter') {
        sendTextMessage();
    }
}

function scrollToBottom() {
    const container = document.getElementById('messagesContainer');
    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showCreateRoomModal() {
    document.getElementById('createRoomModal').style.display = 'flex';
}

function closeCreateRoomModal() {
    document.getElementById('createRoomModal').style.display = 'none';
    document.getElementById('newRoomName').value = '';
}

async function createNewRoom() {
    const roomName = document.getElementById('newRoomName').value.trim();

    if (!roomName) {
        alert('Введите название комнаты');
        return;
    }

    try {
        const response = await fetch('/api/rooms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: roomName,
                created_by: currentUser || 'Anonymous',
                is_private: false
            })
        });

        if (response.ok) {
            const room = await response.json();
            alert(`Комната "${room.name}" успешно создана!`);
            closeCreateRoomModal();
            loadRooms();
            joinRoom(room.id, room.name);
        } else {
            const error = await response.json();
            alert(error.error || 'Ошибка при создании комнаты');
        }
    } catch (error) {
        console.error('Error creating room:', error);
        alert('Ошибка при создании комнаты');
    }
}

function showRoomSelector() {
    const modal = document.getElementById('roomSelectorModal');
    const roomsList = document.getElementById('roomSelectorList');

    roomsList.innerHTML = availableRooms.map(room => `
        <div class="room-item" onclick="switchToRoom('${room.id}', '${room.name}')">
            <div class="room-info">
                <strong>${escapeHtml(room.name)}</strong>
                <span class="room-details">👥 ${room.users_count || 0} участников</span>
            </div>
            ${currentRoomId === room.id ? '<span class="current-room-badge">Текущая</span>' : ''}
        </div>
    `).join('');

    modal.style.display = 'flex';
}

function closeRoomSelector() {
    document.getElementById('roomSelectorModal').style.display = 'none';
}

function switchToRoom(roomId, roomName) {
    if (roomId === currentRoomId) {
        closeRoomSelector();
        return;
    }

    if (isCallActive) {
        endCurrentCall();
    }

    if (socket) {
        socket.emit('leave_room', { user_id: currentUserId });
    }

    currentRoomId = roomId;
    currentRoomName = roomName;

    document.getElementById('messages').innerHTML = '';
    connectToChat();
    closeRoomSelector();
}

function logout() {
    if (isCallActive) {
        endCurrentCall();
    }

    if (socket) {
        socket.emit('leave_room', { user_id: currentUserId });
        socket.disconnect();
    }

    currentUser = null;
    currentUserId = null;
    currentRoomId = 'general';

    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('chatScreen').style.display = 'none';
    document.getElementById('messages').innerHTML = '';
    document.getElementById('username').value = '';

    loadRooms();
}

// Инициализация
document.addEventListener('DOMContentLoaded', () => {
    loadRooms();

    const isPrivateCheckbox = document.getElementById('isPrivateRoom');
    if (isPrivateCheckbox) {
        isPrivateCheckbox.addEventListener('change', (e) => {
            const passwordField = document.getElementById('passwordField');
            if (passwordField) {
                passwordField.style.display = e.target.checked ? 'block' : 'none';
            }
        });
    }

    setInterval(loadRooms, 30000);
});