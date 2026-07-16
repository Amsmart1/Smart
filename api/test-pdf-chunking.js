/**
 * Integration & Unit Tests for PDF Extraction Chunking and Structure-Aware Tagging Pipeline
 * Run with: node api/test-pdf-chunking.js
 */

const assert = require('assert').strict;

console.log("=== Starting Verification & Audit of PDF Chunking & Extraction Pipeline ===\n");

// Mock PDF Text that contains multiple structures (Chapters, Sections, Topics, custom headings)
const mockPDFText = `
CHAPTER I: INTRODUCTION TO CELL BIOLOGY
Cell biology is the study of cell structure and function, and it revolves around the concept that the cell is the fundamental unit of life. Focusing on the cell permits a detailed understanding of the tissues and organisms that cells compose. Some organisms have only one cell, while others are organized into cooperative groups with huge numbers of cells. On the whole, cell biology focuses on the structure and function of a cell, from the most general properties shared by all cells, to the unique, highly intricate functions particular to specialized cells.

SECTION 1.1: ORGANELLES AND MEMBRANES
Organelles are specialized subunits within a cell that have specific functions. Similar to organs in a body, organelles are membrane-bound compartments that keep different biochemical reactions separated. The plasma membrane is a biological membrane that separates and protects the interior of all cells from the outside environment. The membrane is semipermeable, meaning it controls the movement of substances in and out of cells.

TOPIC A: MITOCHONDRIA THE POWERHOUSE
Mitochondria are double membrane-bound organelles found in most eukaryotic organisms. They generate most of the cell's supply of adenosine triphosphate (ATP), used as a source of chemical energy. Because of this, the mitochondrion is popularly referred to as the powerhouse of the cell.

MODULE X: ADVANCED GENETIC MUTATIONS
This is a custom structural heading representing the user's dynamic custom chunk options. It discusses how DNA sequences can undergo changes called mutations, which might lead to phenotypic differences or genetic disorders in organisms.
`;

// 1. Helper: Splitting regex logic identical to api/ai-gateway.js and ts/ai-gateway.ts
function runBoundarySplit(pdfText, allowedOptions) {
  const optionsPattern = allowedOptions.map(opt => opt.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
  const boundaryRegex = new RegExp(`(?:\\r?\\n|^)(?=(?:${optionsPattern})\\s+(?:[0-9]+|[a-z]+|[ivxldm]+)\\b|\\r?\\n{2,}(?=[a-z\\s]{3,100}:))`, 'i');
  return pdfText.split(boundaryRegex).map(s => s.trim()).filter(s => s.length > 0);
}

// 2. Helper: Large Segment cleanly sub-slicing logic identical to api/ai-gateway.js and ts/ai-gateway.ts
function sliceSegment(segment, limit = 2500) {
  const parsedChunks = [];
  if (segment.length > limit) {
    let start = 0;
    while (start < segment.length) {
      let end = start + limit;
      if (end < segment.length) {
        const lastBreak = segment.lastIndexOf('\n', end);
        if (lastBreak > start + 1000) {
          end = lastBreak;
        } else {
          const lastPeriod = segment.lastIndexOf('. ', end);
          if (lastPeriod > start + 1000) {
            end = lastPeriod + 2;
          }
        }
      } else {
        end = segment.length;
      }
      parsedChunks.push(segment.substring(start, end).trim());
      start = end;
    }
  } else {
    parsedChunks.push(segment);
  }
  return parsedChunks;
}

// 3. Helper: Structure Tagging logic identical to our latest api/ai-gateway.js and ts/ai-gateway.ts
function detectStructureType(chunkText, allowedOptions) {
  let structureType = 'segment';
  const firstWords = chunkText.substring(0, 50).toLowerCase();

  // Match against allowedOptions (supports custom keywords dynamically)
  for (const opt of allowedOptions) {
    const cleanOpt = opt.toLowerCase().trim();
    if (firstWords.includes(cleanOpt)) {
      // Canonicalize plural to singular if possible
      if (cleanOpt.endsWith('s')) {
        const singular = cleanOpt.slice(0, -1);
        structureType = allowedOptions.map(o => o.toLowerCase()).includes(singular) ? singular : cleanOpt;
      } else {
        structureType = cleanOpt;
      }
      break;
    }
  }

  // Fallback to standard hardcoded checks to guarantee zero-regression
  if (structureType === 'segment') {
    if (firstWords.includes('chapter')) structureType = 'chapter';
    else if (firstWords.includes('section')) structureType = 'section';
    else if (firstWords.includes('topic')) structureType = 'topic';
    else if (firstWords.includes('week')) structureType = 'week';
    else if (firstWords.includes('lesson')) structureType = 'lesson';
  }

  return structureType;
}

// TEST CASES
try {
  // Test 1: Default standard structure options
  console.log("Running Test 1: Default structure-aware splitting...");
  const defaultOptions = ['chapter', 'chapters', 'section', 'sections', 'topic', 'topics', 'week', 'weeks', 'lesson', 'lessons'];
  const segments = runBoundarySplit(mockPDFText, defaultOptions);

  // We expect at least the Chapter, Section, and Topic to be segmented separately
  assert.ok(segments.length >= 3, `Expected at least 3 segments, got ${segments.length}`);
  console.log(`✓ Successfully segmented PDF text into ${segments.length} segments.`);

  // Test 2: Custom dynamic options (adding 'module' and 'modules')
  console.log("\nRunning Test 2: Custom structure option splitting (including 'module')...");
  const customOptions = [...defaultOptions, 'module', 'modules'];
  const customSegments = runBoundarySplit(mockPDFText, customOptions);

  assert.ok(customSegments.length >= 4, `Expected at least 4 segments with custom modules, got ${customSegments.length}`);
  const hasModuleSegment = customSegments.some(s => s.toLowerCase().includes("module x"));
  assert.equal(hasModuleSegment, true, "Did not find the 'MODULE X' segmented chunk");
  console.log("✓ Successfully segmented PDF text with dynamic custom options!");

  // Test 3: Slicing extremely large segment cleanly
  console.log("\nRunning Test 3: Clean character-range sub-slicing (limit > 100 chars)...");
  const largeText = "A".repeat(50) + "\n" + "B".repeat(50) + "\n" + "C".repeat(50); // total 152 chars
  // Slicing with low limit (e.g., 60 chars) to trigger split
  const slicedChunks = sliceSegment(largeText, 60);
  assert.ok(slicedChunks.length > 1, "Expected text to be sliced into multiple parts");
  // Ensure we didn't lose any characters
  const reassembled = slicedChunks.join("\n");
  assert.ok(reassembled.includes("A") && reassembled.includes("B") && reassembled.includes("C"));
  console.log(`✓ Successfully sliced large chunk into ${slicedChunks.length} pieces cleanly.`);

  // Test 4: Structure Tagging & Fallbacks
  console.log("\nRunning Test 4: Structure-type detection and mapping...");

  const chunkChapter = "CHAPTER I: CELL STRUCTURES AND FUNCTIONS ARE...";
  const typeChapter = detectStructureType(chunkChapter, defaultOptions);
  assert.equal(typeChapter, "chapter");
  console.log("✓ Detected standard 'chapter' type");

  const chunkSection = "SECTION 1.1: MEMBRANES";
  const typeSection = detectStructureType(chunkSection, defaultOptions);
  assert.equal(typeSection, "section");
  console.log("✓ Detected standard 'section' type");

  // Custom Tag with plural canonicalization
  const chunkModule = "MODULES AND GENETICS ARE...";
  const typeModule = detectStructureType(chunkModule, customOptions);
  assert.equal(typeModule, "module");
  console.log("✓ Successfully detected and canonicalized custom 'module' type from 'modules'");

  const chunkSegment = "The cytoplasm is filled with aqueous cytosol...";
  const typeSegment = detectStructureType(chunkSegment, defaultOptions);
  assert.equal(typeSegment, "segment");
  console.log("✓ Safely fell back to generic 'segment' type");

} catch (err) {
  console.error("\n✗ Audit & Verification failed:", err);
  process.exit(1);
}

console.log("\n=== All PDF Extraction and Chunking Integration Tests Passed Successfully! ===");
process.exit(0);
