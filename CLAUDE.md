# GVGAI Project - Claude Context

## Project Overview
This is a configured instance of the General Video Game AI (GVGAI) framework, set up as a proof of concept to demonstrate AI agents playing 2D games defined in Video Game Description Language (VGDL).

## Setup Status
- **Repository**: Cloned from https://github.com/GAIGResearch/GVGAI
- **Build System**: Manual compilation using javac (no ANT build.xml in this repo version)
- **Java Version**: OpenJDK 11 (installed via Homebrew)
- **Status**: Fully functional and tested

## Key Modifications Made
1. **Test.java Configuration** ([src/tracks/singlePlayer/Test.java](src/tracks/singlePlayer/Test.java))
   - Modified to run AI agent instead of human play mode
   - Changed line 49: Commented out `ArcadeMachine.playOneGame()`
   - Changed line 52: Enabled `ArcadeMachine.runOneGame()` with `sampleRandomController`
   - Default game: Aliens (index 0)
   - Default level: 0

2. **Build Process**
   - Compiled all Java sources into `out/` directory
   - Uses gson-2.6.2.jar dependency (included in repo)

3. **Documentation**
   - Created [SETUP.md](SETUP.md) with comprehensive setup and usage instructions

## Build Commands

### Environment Setup (Required)
```bash
export PATH="/usr/local/opt/openjdk@11/bin:/usr/bin:$PATH"
export JAVA_HOME="/usr/local/opt/openjdk@11"
```

### Compile Project
```bash
/usr/bin/find src -name "*.java" > sources.txt
javac -cp "gson-2.6.2.jar" -d out @sources.txt
```

### Recompile Test.java Only
```bash
javac -cp "gson-2.6.2.jar:out" -d out src/tracks/singlePlayer/Test.java
```

### Run Demo
```bash
java -cp "out:gson-2.6.2.jar:." tracks.singlePlayer.Test
```

## Project Structure

### Important Directories
- **src/** - Java source code
  - **src/tracks/singlePlayer/** - Single-player track test runners and agents
    - **Test.java** - Main entry point (modified)
    - **simple/** - Simple agent implementations (Random, DoNothing, etc.)
    - **advanced/** - Advanced agents (MCTS, RHEA, OLETS)
  - **core/** - Game engine core
  - **ontology/** - Game object definitions
  - **tools/** - Utilities and helpers

- **examples/** - Game definitions in VGDL
  - **gridphysics/** - 100+ grid-based games
  - **all_games_sp.csv** - Single-player game index

- **sprites/** - Game graphics
- **out/** - Compiled classes (gitignored)

### Files to Ignore
- **out/** - Compiled bytecode
- **sources.txt** - Auto-generated file list
- **.idea/** - IntelliJ IDEA project files

## Available Agents

### Simple (src/tracks/singlePlayer/simple/)
- `doNothing.Agent` - Takes no actions
- `sampleRandom.Agent` - Random action selection
- `sampleonesteplookahead.Agent` - One-step lookahead
- `greedyTreeSearch.Agent` - Greedy tree search

### Advanced (src/tracks/singlePlayer/advanced/)
- `sampleMCTS.Agent` - Monte Carlo Tree Search
- `sampleRS.Agent` - Random Search
- `sampleRHEA.Agent` - Rolling Horizon Evolutionary Algorithm
- `olets.Agent` - Open Loop Expectimax Tree Search

## Available Games
See [examples/all_games_sp.csv](examples/all_games_sp.csv) for complete list.

Popular games for testing:
- **0**: Aliens (currently configured)
- **9**: Bomberman
- **19**: Chips Challenge
- **37**: Pac-Man
- **78**: Zelda

## Game Configuration
Edit [src/tracks/singlePlayer/Test.java](src/tracks/singlePlayer/Test.java):

```java
// Select game (line 37)
int gameIdx = 0;  // 0-99+ (see all_games_sp.csv)

// Select level (line 38)
int levelIdx = 0;  // 0-4 (game_lvl0.txt to game_lvl4.txt)

// Select agent (line 52)
ArcadeMachine.runOneGame(game, level1, visuals, sampleRandomController, recordActionsFile, seed, 0);
// Replace sampleRandomController with any agent from the lists above
```

## Testing Results
Initial test run:
- Game: Aliens (level 0)
- Agent: Random Agent
- Result: Loss (score: 53.0, timesteps: 477)
- Status: Framework operational

## Dependencies
- **gson-2.6.2.jar** - JSON processing (included in repo)
- **OpenJDK 11+** - Java runtime and compiler
- **macOS** - Developed and tested on macOS (Homebrew installation)

## Common Tasks

### Change to a Different Game
1. Find game index in [examples/all_games_sp.csv](examples/all_games_sp.csv)
2. Edit `gameIdx` in [Test.java](src/tracks/singlePlayer/Test.java):37
3. Recompile Test.java
4. Run demo

### Test a Different Agent
1. Choose agent from list above
2. Edit line 52 in [Test.java](src/tracks/singlePlayer/Test.java)
3. Recompile Test.java
4. Run demo

### Disable Visual Window
1. Edit [Test.java](src/tracks/singlePlayer/Test.java):33
2. Change `boolean visuals = true;` to `false`
3. Recompile and run

### Record Actions
1. Edit [Test.java](src/tracks/singlePlayer/Test.java):43
2. Uncomment action file path
3. Recompile and run
4. Actions saved to text file for replay

## Resources
- **Setup Guide**: [SETUP.md](SETUP.md)
- **Official Website**: http://www.gvgai.net/
- **GitHub Repo**: https://github.com/GAIGResearch/GVGAI
- **Code Structure**: [README_CODE_STRUCTURE.txt](README_CODE_STRUCTURE.txt)
- **Learning Track**: https://github.com/rubenrtorrado/GVGAI_GYM

## Development Notes
- Framework uses reflection to load agents by class path string
- Game states are observable through StateObservation API
- Agents must complete action selection within time budget (ElapsedCpuTimer)
- Games can be human-playable or AI-controlled
- VGDL files define game rules, sprites, levels, and interactions

## Future Enhancements
- Implement custom agents with learning capabilities
- Batch testing across multiple games/agents
- Performance benchmarking suite
- Custom game creation in VGDL
- Integration with ML frameworks (TensorFlow, PyTorch)
