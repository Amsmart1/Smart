/**
 * Verification & Audit Test Suite for Hierarchy-Aware Semantic Chunking Pipeline
 * Run with: node api/test-hierarchy-semantic-chunking.js
 */

const assert = require('assert').strict;

console.log("=== Verification: Hierarchy-Aware Semantic Chunking Pipeline ===\n");

// Mock PDF Text containing full course syllabus with document hierarchy and definitions/examples/exercises
const sampleText = `
CHAPTER 1: INTRODUCTION TO ORGANIC CHEMISTRY
Organic chemistry is the study of the structure, properties, composition, reactions, and preparation of carbon-containing compounds. Most organic compounds contain carbon and hydrogen, but they may also include any number of other elements.

SECTION 1.1: HYDROCARBONS AND ALKANES
Hydrocarbons are organic compounds consisting entirely of hydrogen and carbon. Alkanes are the simplest family of hydrocarbons.

TOPIC A: PROPANE AND BUTANE
Propane is a three-carbon alkane with the molecular formula C3H8. Butane is an organic compound with the formula C4H10 that is an alkane with four carbon atoms.

DEFINITION: An alkane is a saturated hydrocarbon with the general chemical formula CnH2n+2.

EXAMPLE: Propane (C3H8) and Butane (C4H10) are excellent real-world examples of alkanes used in daily fuel sources.

EXERCISE: Write down the molecular structure of hexane, which is an alkane with 6 carbon atoms, and balance its combustion equation.
`;

function splitSemantically(rawText, limit) {
    const paragraphs = rawText.split(/\r?\n{2,}/);
    const subChunks = [];
    let currentBlock = "";

    for (const para of paragraphs) {
        const cleanPara = para.trim();
        if (!cleanPara) continue;

        if ((currentBlock + "\n\n" + cleanPara).length <= limit) {
            currentBlock = currentBlock ? currentBlock + "\n\n" + cleanPara : cleanPara;
        } else {
            if (currentBlock) {
                subChunks.push(currentBlock);
                currentBlock = "";
            }

            if (cleanPara.length <= limit) {
                currentBlock = cleanPara;
            } else {
                const sentences = cleanPara.match(/[^.!?]+[.!?]+(\s+|$)/g) || [cleanPara];
                for (const sentence of sentences) {
                    const cleanSentence = sentence.trim();
                    if (!cleanSentence) continue;

                    if ((currentBlock + " " + cleanSentence).length <= limit) {
                        currentBlock = currentBlock ? currentBlock + " " + cleanSentence : cleanSentence;
                    } else {
                        if (currentBlock) {
                            subChunks.push(currentBlock);
                        }
                        currentBlock = cleanSentence;
                    }
                }
            }
        }
    }
    if (currentBlock) {
        subChunks.push(currentBlock);
    }
    return subChunks;
}

function chunkText(normalizedText, title, chunkOptions) {
    const allowedOptions = chunkOptions || ['chapter', 'chapters', 'section', 'sections', 'topic', 'topics', 'week', 'weeks', 'lesson', 'lessons'];
    const optionsPattern = allowedOptions.map(opt => opt.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
    const boundaryRegex = new RegExp(`(?:\\r?\\n|^)(?=(?:${optionsPattern})\\s+(?:[0-9]+|[a-z]+|[ivxldm]+)\\b|\\r?\\n(?=[a-z\\s]{3,100}:))`, 'i');
    const rawSegments = normalizedText.split(boundaryRegex).map(s => s.trim()).filter(s => s.length > 0);

    const localChunks = [];
    let chunkIndex = 0;

    let currentChapter = "";
    let currentSection = "";
    let currentTopic = "";

    for (const segment of rawSegments) {
        const firstWords = segment.substring(0, 100).toLowerCase();

        if (/\b(?:chapter|chapters)\b/i.test(firstWords)) {
            const match = segment.match(/^(?:chapter|chapters)\s+([^\r\n:]+)/i);
            if (match) currentChapter = match[1].trim();
        } else if (/\b(?:section|sections)\b/i.test(firstWords)) {
            const match = segment.match(/^(?:section|sections)\s+([^\r\n:]+)/i);
            if (match) currentSection = match[1].trim();
        } else if (/\b(?:topic|topics)\b/i.test(firstWords)) {
            const match = segment.match(/^(?:topic|topics)\s+([^\r\n:]+)/i);
            if (match) currentTopic = match[1].trim();
        }

        const parts = splitSemantically(segment, 2500);

        for (const part of parts) {
            let structureType = 'segment';
            const partFirstWords = part.substring(0, 100).toLowerCase();

            if (/\b(?:definition|definitions|define)\b/i.test(partFirstWords)) {
                structureType = 'definition';
            } else if (/\b(?:example|examples|eg\.?)\b/i.test(partFirstWords)) {
                structureType = 'example';
            } else if (/\b(?:exercise|exercises|practice|question|quiz)\b/i.test(partFirstWords)) {
                structureType = 'exercise';
            } else {
                for (const opt of allowedOptions) {
                    const cleanOpt = opt.toLowerCase().trim();
                    if (partFirstWords.includes(cleanOpt)) {
                        if (cleanOpt.endsWith('s')) {
                            const singular = cleanOpt.slice(0, -1);
                            structureType = allowedOptions.map(o => o.toLowerCase()).includes(singular) ? singular : cleanOpt;
                        } else {
                            structureType = cleanOpt;
                        }
                        break;
                    }
                }
            }

            if (structureType === 'segment') {
                if (partFirstWords.includes('chapter')) structureType = 'chapter';
                else if (partFirstWords.includes('section')) structureType = 'section';
                else if (partFirstWords.includes('topic')) structureType = 'topic';
                else if (partFirstWords.includes('week')) structureType = 'week';
                else if (partFirstWords.includes('lesson')) structureType = 'lesson';
            }

            let pathHeader = `Document: ${title}`;
            if (currentChapter) pathHeader += ` > Chapter: ${currentChapter}`;
            if (currentSection) pathHeader += ` > Section: ${currentSection}`;
            if (currentTopic) pathHeader += ` > Topic: ${currentTopic}`;

            localChunks.push({
                content: `Hierarchy Context: ${pathHeader}\nStructure: ${structureType.toUpperCase()}\nContent Segment:\n${part}`,
                metadata: {
                    type: 'material_pdf',
                    title: title,
                    chunk_index: chunkIndex++,
                    structure_type: structureType,
                    chapter: currentChapter || null,
                    section: currentSection || null,
                    topic: currentTopic || null
                }
            });
        }
    }
    return localChunks;
}

// EXECUTE TESTS
try {
    console.log("Running Test 1: Semantically partition mock syllabus...");
    const chunks = chunkText(sampleText.trim(), "Chemistry 101", null);

    console.log(`Generated ${chunks.length} chunks.`);
    assert.ok(chunks.length >= 6, `Expected at least 6 chunks, got ${chunks.length}`);

    // Verify Hierarchy tracking
    const chunk1 = chunks[0];
    assert.equal(chunk1.metadata.chapter, "1");
    assert.equal(chunk1.metadata.structure_type, "chapter");
    assert.ok(chunk1.content.includes("Hierarchy Context: Document: Chemistry 101 > Chapter: 1"), "Chapter path missing");

    const chunk3 = chunks[2];
    assert.equal(chunk3.metadata.chapter, "1");
    assert.equal(chunk3.metadata.section, "1.1");
    assert.equal(chunk3.metadata.topic, "A");
    assert.ok(chunk3.content.includes("Chemistry 101 > Chapter: 1 > Section: 1.1 > Topic: A"), "Full path missing");

    // Verify Element type detection: Definitions, Examples, Exercises
    const definitionChunk = chunks.find(c => c.metadata.structure_type === 'definition');
    assert.ok(definitionChunk, "Definition chunk not detected");
    assert.equal(definitionChunk.metadata.chapter, "1");
    assert.equal(definitionChunk.metadata.section, "1.1");
    assert.equal(definitionChunk.metadata.topic, "A");

    const exampleChunk = chunks.find(c => c.metadata.structure_type === 'example');
    assert.ok(exampleChunk, "Example chunk not detected");

    const exerciseChunk = chunks.find(c => c.metadata.structure_type === 'exercise');
    assert.ok(exerciseChunk, "Exercise chunk not detected");

    console.log("\n✓ All Hierarchy and Semantic Chunking tests passed successfully!");
} catch (err) {
    console.error("\n✗ Verification tests failed:", err);
    process.exit(1);
}
process.exit(0);
