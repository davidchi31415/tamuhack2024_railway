-- CreateTable
CREATE TABLE `Job` (
    `id` VARCHAR(191) NOT NULL,
    `prompt` VARCHAR(191) NOT NULL,
    `n_scenes` INTEGER NOT NULL DEFAULT 0,
    `done_text` BOOLEAN NOT NULL DEFAULT false,
    `done_image` BOOLEAN NOT NULL DEFAULT false,
    `done_audio` BOOLEAN NOT NULL DEFAULT false,
    `done_video` BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
