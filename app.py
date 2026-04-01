from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_cors import CORS
import os
from datetime import datetime
import uuid
import secrets

app = Flask(__name__)
app.config['SECRET_KEY'] = secrets.token_hex(16)
CORS(app)

# Используем простой async_mode для совместимости
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Хранилище данных
messages = []
rooms = {}
users = {}  # {user_id: {username: str, room: str, socket_id: str, in_call: bool, call_with: str}}
active_calls = {}  # {call_id: {caller: str, callee: str, room: str, status: str}}


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory('static', filename)


@app.route('/api/rooms')
def get_rooms():
    rooms_list = []
    for room_id, room_data in rooms.items():
        rooms_list.append({
            'id': room_id,
            'name': room_data['name'],
            'created_by': room_data['created_by'],
            'created_at': room_data['created_at'],
            'users_count': len(room_data.get('users', [])),
            'is_private': room_data.get('is_private', False)
        })
    return jsonify(rooms_list)


@app.route('/api/rooms', methods=['POST'])
def create_room():
    data = request.json
    room_name = data.get('name', '').strip()
    created_by = data.get('created_by', 'Anonymous')
    is_private = data.get('is_private', False)

    if not room_name:
        return jsonify({'error': 'Room name is required'}), 400

    for room_id, room_data in rooms.items():
        if room_data['name'].lower() == room_name.lower():
            return jsonify({'error': 'Room with this name already exists'}), 400

    room_id = str(uuid.uuid4())[:8]
    rooms[room_id] = {
        'id': room_id,
        'name': room_name,
        'created_by': created_by,
        'created_at': datetime.now().isoformat(),
        'users': [],
        'is_private': is_private,
        'password': data.get('password') if is_private else None
    }

    return jsonify({
        'id': room_id,
        'name': room_name,
        'created_by': created_by,
        'created_at': rooms[room_id]['created_at']
    }), 201


@app.route('/api/rooms/<room_id>', methods=['DELETE'])
def delete_room(room_id):
    if room_id in rooms:
        socketio.emit('room_deleted', {'room_id': room_id, 'room_name': rooms[room_id]['name']}, room=room_id)
        del rooms[room_id]
        return jsonify({'success': True}), 200
    return jsonify({'error': 'Room not found'}), 404


@app.route('/api/messages')
def get_messages():
    room = request.args.get('room', 'general')
    room_messages = [msg for msg in messages if msg.get('room') == room]
    return jsonify(room_messages[-50:])  # Последние 50 сообщений


@app.route('/api/messages', methods=['POST'])
def save_message():
    data = request.json
    message = {
        'id': str(uuid.uuid4()),
        'username': data.get('username', 'Anonymous'),
        'text': data.get('text', ''),
        'type': data.get('type', 'text'),
        'timestamp': datetime.now().isoformat(),
        'room': data.get('room', 'general')
    }
    messages.append(message)

    if len(messages) > 1000:
        messages.pop(0)

    socketio.emit('new_message', message, room=message['room'])
    return jsonify(message), 201


@socketio.on('connect')
def handle_connect():
    print(f'Client connected: {request.sid}')


@socketio.on('disconnect')
def handle_disconnect():
    # Находим пользователя по socket_id
    user_to_remove = None
    for user_id, user_data in users.items():
        if user_data.get('socket_id') == request.sid:
            user_to_remove = user_id
            break

    if user_to_remove:
        user_data = users[user_to_remove]
        room = user_data.get('room')
        username = user_data.get('username')

        # Если пользователь был в звонке, завершаем звонок
        if user_data.get('in_call'):
            end_call(user_to_remove)

        if room and room in rooms:
            if username in rooms[room].get('users', []):
                rooms[room]['users'].remove(username)

            emit('user_left', {
                'user_id': user_to_remove,
                'username': username,
                'timestamp': datetime.now().isoformat(),
                'users_count': len(rooms[room]['users'])
            }, room=room)

        del users[user_to_remove]


@socketio.on('register_user')
def register_user(data):
    username = data.get('username')
    room_id = data.get('room_id', 'general')

    user_id = str(uuid.uuid4())[:8]
    users[user_id] = {
        'id': user_id,
        'username': username,
        'room': room_id,
        'socket_id': request.sid,
        'in_call': False,
        'call_with': None
    }

    join_room(room_id)

    if room_id in rooms:
        if username not in rooms[room_id].get('users', []):
            rooms[room_id].setdefault('users', []).append(username)

    emit('user_registered', {
        'user_id': user_id,
        'username': username
    })

    # Отправляем список пользователей
    send_users_list(room_id)

    emit('user_joined', {
        'user_id': user_id,
        'username': username,
        'timestamp': datetime.now().isoformat(),
        'users_count': len(rooms.get(room_id, {}).get('users', []))
    }, room=room_id)


def send_users_list(room_id):
    room_users = []
    for uid, user_data in users.items():
        if user_data.get('room') == room_id:
            room_users.append({
                'id': uid,
                'username': user_data['username'],
                'in_call': user_data.get('in_call', False),
                'call_with': user_data.get('call_with')
            })
    emit('users_list', {'users': room_users}, room=room_id)


@socketio.on('call_user')
def call_user(data):
    caller_id = data.get('caller_id')
    callee_id = data.get('callee_id')
    call_type = data.get('type', 'audio')

    if caller_id not in users or callee_id not in users:
        emit('call_error', {'message': 'User not found'}, room=request.sid)
        return

    caller = users[caller_id]
    callee = users[callee_id]

    if caller.get('in_call'):
        emit('call_error', {'message': 'You are already in a call'}, room=request.sid)
        return

    if callee.get('in_call'):
        emit('call_error', {'message': 'User is already in a call'}, room=request.sid)
        return

    call_id = str(uuid.uuid4())[:8]
    active_calls[call_id] = {
        'id': call_id,
        'caller_id': caller_id,
        'callee_id': callee_id,
        'caller_name': caller['username'],
        'callee_name': callee['username'],
        'room': caller['room'],
        'type': call_type,
        'status': 'calling',
        'started_at': datetime.now().isoformat()
    }

    caller['in_call'] = True
    caller['call_with'] = callee_id
    callee['in_call'] = True
    callee['call_with'] = caller_id

    # Отправляем запрос на звонок
    emit('incoming_call', {
        'call_id': call_id,
        'caller_id': caller_id,
        'caller_name': caller['username'],
        'type': call_type
    }, room=callee['socket_id'])

    # Обновляем списки пользователей
    send_users_list(caller['room'])

    emit('call_status', {
        'status': 'calling',
        'callee_name': callee['username']
    }, room=caller['socket_id'])


@socketio.on('accept_call')
def accept_call(data):
    call_id = data.get('call_id')
    callee_id = data.get('callee_id')

    if call_id not in active_calls:
        emit('call_error', {'message': 'Call not found'})
        return

    call = active_calls[call_id]
    caller = users.get(call['caller_id'])
    callee = users.get(callee_id)

    if not caller or not callee:
        return

    call['status'] = 'active'

    emit('call_accepted', {
        'call_id': call_id,
        'callee_id': callee_id,
        'callee_name': callee['username']
    }, room=caller['socket_id'])

    emit('call_connected', {
        'call_id': call_id,
        'caller_id': call['caller_id'],
        'caller_name': call['caller_name']
    }, room=callee['socket_id'])


@socketio.on('reject_call')
def reject_call(data):
    call_id = data.get('call_id')
    callee_id = data.get('callee_id')

    if call_id in active_calls:
        call = active_calls[call_id]
        caller = users.get(call['caller_id'])
        callee = users.get(callee_id)

        if caller:
            emit('call_rejected', {
                'call_id': call_id,
                'callee_name': callee['username'] if callee else 'User'
            }, room=caller['socket_id'])

        end_call(call['caller_id'])
        end_call(callee_id)

        if call_id in active_calls:
            del active_calls[call_id]


@socketio.on('end_call')
def end_call_from_client(data):
    user_id = data.get('user_id')
    end_call(user_id)


def end_call(user_id):
    if user_id not in users:
        return

    user = users[user_id]
    if not user.get('in_call'):
        return

    call_with_id = user.get('call_with')
    call_with = users.get(call_with_id) if call_with_id else None

    # Находим и удаляем активный звонок
    call_id = None
    for cid, call in active_calls.items():
        if call['caller_id'] == user_id or call['callee_id'] == user_id:
            call_id = cid
            break

    if call_id:
        call = active_calls[call_id]
        del active_calls[call_id]

        # Уведомляем другого участника
        other_id = call['caller_id'] if call['callee_id'] == user_id else call['callee_id']
        if other_id in users:
            emit('call_ended', {
                'call_id': call_id,
                'ended_by': user['username']
            }, room=users[other_id]['socket_id'])

    # Сбрасываем статус звонка
    user['in_call'] = False
    user['call_with'] = None

    if call_with:
        call_with['in_call'] = False
        call_with['call_with'] = None

    # Обновляем список пользователей в комнате
    if user.get('room'):
        send_users_list(user['room'])


@socketio.on('webrtc_offer')
def webrtc_offer(data):
    target_id = data.get('target_id')
    if target_id in users:
        emit('webrtc_offer', {
            'offer': data.get('offer'),
            'caller_id': data.get('caller_id'),
            'caller_name': data.get('caller_name')
        }, room=users[target_id]['socket_id'])


@socketio.on('webrtc_answer')
def webrtc_answer(data):
    target_id = data.get('target_id')
    if target_id in users:
        emit('webrtc_answer', {
            'answer': data.get('answer'),
            'callee_id': data.get('callee_id')
        }, room=users[target_id]['socket_id'])


@socketio.on('webrtc_ice_candidate')
def webrtc_ice_candidate(data):
    target_id = data.get('target_id')
    if target_id in users:
        emit('webrtc_ice_candidate', {
            'candidate': data.get('candidate')
        }, room=users[target_id]['socket_id'])


@socketio.on('leave_room')
def leave_room_event(data):
    user_id = data.get('user_id')
    if user_id in users:
        user = users[user_id]
        room = user.get('room')

        if user.get('in_call'):
            end_call(user_id)

        if room and room in rooms:
            if user['username'] in rooms[room].get('users', []):
                rooms[room]['users'].remove(user['username'])

            emit('user_left', {
                'user_id': user_id,
                'username': user['username'],
                'timestamp': datetime.now().isoformat(),
                'users_count': len(rooms[room]['users'])
            }, room=room)

            send_users_list(room)

        leave_room(room)
        del users[user_id]


if __name__ == '__main__':
    # Создаем стандартную комнату "General"
    if 'general' not in rooms:
        rooms['general'] = {
            'id': 'general',
            'name': 'General',
            'created_by': 'System',
            'created_at': datetime.now().isoformat(),
            'users': [],
            'is_private': False
        }

    # Запускаем сервер
    socketio.run(app, debug=True, host='127.0.0.1', port=5000, allow_unsafe_werkzeug=True)