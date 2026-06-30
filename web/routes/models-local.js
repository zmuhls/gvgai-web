const express = require('express');
const { MODELS } = require('../lib/models');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(MODELS);
});

module.exports = router;
