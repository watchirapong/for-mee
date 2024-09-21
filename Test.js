const mqtt = require('mqtt');

// MQTT Broker settings
const mqttOptions = { host: '1.tcp.ap.ngrok.io', port: 22851 };
const client = mqtt.connect(mqttOptions);

const esp32Devices = {};
const NUM_ROUNDS = 10;
const HP_DEDUCTION = 1;

client.on('connect', () => {
  console.log('Connected to MQTT broker');
  subscribeToTopics(['esp32/connect', 'esp32/disconnect']);
});

function subscribeToTopics(topics) {
  client.subscribe(topics, (err) => {
    if (err) {
      console.error('Failed to subscribe:', err);
    } else {
      console.log('Subscribed to topics:', topics.join(', '));
    }
  });
}
//
function handleNewESP32(macAddress, name, hp) {
  console.log(`New ESP32 connected: MAC=${macAddress}, Name=${name}, HP=${hp}`);

  esp32Devices[macAddress] = {
    name, hp, currentRound: 0, correctResponses: 0, incorrectResponses: 0,
    isDead: false, sentNumber: null, sequence: 0, lastAcknowledgedSequence: -1,
    retryCount: 0, autoRestartTimer: null,
    requestTopic: `esp32/${macAddress}/random`,
    responseTopic: `esp32/${macAddress}/response`,
    resultTopic: `esp32/${macAddress}/result`,
  };

  subscribeToTopics([`esp32/${macAddress}/response`]);
  sendRandomNumberToDevice(macAddress);
}

function handleESP32Disconnect(macAddress) {
  if (!macAddress || !esp32Devices[macAddress]) {
    console.error(`Error: Invalid device disconnect - MAC: ${macAddress}`);
    return;
  }

  const device = esp32Devices[macAddress];
  console.log(`ESP32 disconnected: MAC=${macAddress}, Name=${device.name}`);

  client.unsubscribe(`esp32/${macAddress}/response`);
  clearTimeout(device.autoRestartTimer);
  device.isDead = true;
  displayScoreboard(macAddress);
}

function sendRandomNumberToDevice(macAddress) {
  const device = esp32Devices[macAddress];
  if (!device) {
    console.error(`Error: Device with MAC ${macAddress} not found`);
    return;
  }

  if (device.hp > 0 && device.currentRound < NUM_ROUNDS) {
    const randomNumber = Math.floor(Math.random() * 3) + 1;
    device.sentNumber = randomNumber;
    device.sequence++;

    const message = JSON.stringify({
      number: randomNumber,
      hp: device.hp,
      round: device.currentRound + 1,
      sequence: device.sequence
    });

    console.log(`Sending to ${device.name}: ${message}`);
    client.publish(device.requestTopic, message);
  } else {
    handleGameOver(macAddress);
  }
}

function handleGameOver(macAddress) {
  const device = esp32Devices[macAddress];
  console.log(`Game over for ${device.name}`);
  displayScoreboard(macAddress);

  setTimeout(() => {
    client.publish(device.resultTopic, JSON.stringify({ gameOver: true, hp: device.hp }));
    scheduleAutoRestart(macAddress);
  }, 2000);
}

function displayScoreboard(macAddress) {
  const device = esp32Devices[macAddress];
  console.log(`\n--- Scoreboard for ${device.name} ---`);
  console.log(`Correct: ${device.correctResponses}, Incorrect: ${device.incorrectResponses}, HP: ${device.hp}`);
  console.log('-----------------------------------\n');
}

function scheduleAutoRestart(macAddress) {
  const device = esp32Devices[macAddress];
  console.log(`Scheduling auto-restart for ${device.name} in 5 seconds`);
  clearTimeout(device.autoRestartTimer);
  device.autoRestartTimer = setTimeout(() => restartGame(macAddress), 5000);
}

function restartGame(macAddress) {
  const device = esp32Devices[macAddress];
  if (device) {
    Object.assign(device, {
      hp: 5, currentRound: 0, correctResponses: 0, incorrectResponses: 0,
      isDead: false, sentNumber: null, retryCount: 0
    });
    console.log(`Game restarted for ${device.name} (MAC: ${macAddress})`);
    sendRandomNumberToDevice(macAddress);
  }
}

client.on('message', (topic, message) => {
  const receivedMessage = message.toString();
  console.log(`Received on ${topic}: ${receivedMessage}`);

  if (topic === 'esp32/connect') {
    handleConnect(JSON.parse(receivedMessage));
  } else if (topic === 'esp32/disconnect') {
    handleESP32Disconnect(JSON.parse(receivedMessage).id);
  } else {
    handleDeviceMessage(topic, receivedMessage);
  }
});

function handleConnect(deviceInfo) {
  const { id, name, hp, restart } = deviceInfo;
  if (restart) {
    console.log(`Restart request from ${name} (MAC: ${id})`);
    restartGame(id);
  } else {
    handleNewESP32(id, name, hp);
  }
}

function handleDeviceMessage(topic, receivedMessage) {
  const macAddress = topic.split('/')[1];
  const device = esp32Devices[macAddress];

  if (!device) {
    console.error(`Unknown device for topic: ${topic}`);
    return;
  }

  const parsedMessage = JSON.parse(receivedMessage);
  if (parsedMessage.ack) {
    handleAcknowledgment(device, parsedMessage.ack);
  } else {
    handleGuess(device, macAddress, parsedMessage);
  }
}

function handleAcknowledgment(device, ackSequence) {
  device.lastAcknowledgedSequence = ackSequence;
  console.log(`Received ACK for sequence ${ackSequence} from ${device.name}`);
}

function handleGuess(device, macAddress, parsedMessage) {
  const { guess, sequence } = parsedMessage;
  console.log(`Guess from ${device.name}: ${guess}, sent: ${device.sentNumber}, seq: ${sequence}`);

  if (sequence !== device.sequence) {
    handleSequenceMismatch(device, macAddress);
    return;
  }

  device.retryCount = 0;
  processGuess(device, macAddress, guess);
}

function handleSequenceMismatch(device, macAddress) {
  console.log(`Sequence mismatch for ${device.name}. Resending last number.`);
  if (device.retryCount < 3) {
    device.retryCount++;
    sendRandomNumberToDevice(macAddress);
  } else {
    console.error(`Too many mismatches for ${device.name}. Resetting game.`);
    restartGame(macAddress);
  }
}

function processGuess(device, macAddress, guess) {
  if (guess >= 1 && guess <= 3) {
    const result = guess === device.sentNumber ? 'nice' : 'nope';
    updateDeviceState(device, result);
    sendResultToDevice(device, result);
    device.currentRound++;
    device.sentNumber = null;
    sendRandomNumberToDevice(macAddress);
  }
}

function updateDeviceState(device, result) {
  if (result === 'nice') {
    device.correctResponses++;
  } else {
    device.incorrectResponses++;
    device.hp -= HP_DEDUCTION;
  }
}

function sendResultToDevice(device, result) {
  const resultMessage = JSON.stringify({
    result, hp: device.hp, sequence: device.sequence
  });
  console.log(`Sending result to ${device.name}: ${resultMessage}`);
  client.publish(device.resultTopic, resultMessage);
}

client.on('error', (err) => console.error('Connection error:', err));
client.on('close', () => console.log('Connection closed'));
